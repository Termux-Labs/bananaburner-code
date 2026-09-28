import * as vscode from "vscode";
import { ApiError, BotHostingApi, FileEntry } from "./api";
import { RemoteActivity } from "./progress";
//
export class RemoteFileSystemProvider implements vscode.FileSystemProvider {
  private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  private cache: Map<string, string> = new Map();
  private metadata: Map<string, FileEntry> = new Map();

  constructor(private api: BotHostingApi, private activity?: RemoteActivity) { }

  private async run<T>(label: string, operation: () => Promise<T>): Promise<T> {
    return this.activity ? this.activity.run(label, operation) : operation();
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { deploymentId, path } = this.parseUri(uri);

    if (path === "/" || path === "") {
      return {
        type: vscode.FileType.Directory,
        ctime: 0,
        mtime: 0,
        size: 0,
      };
    }
      var entry = this.metadata.get(this.key(deploymentId, path));
      if (!entry) {
        var parent = path.substring(0, path.lastIndexOf("/")) || "/";
        var name = path.substring(path.lastIndexOf("/") + 1);
        var listing = await this.api.listFiles(deploymentId, parent);
        entry = (listing.entries || []).find(function (candidate) { return candidate.name === name; });
        if (entry) this.metadata.set(this.key(deploymentId, path), entry);
      }
      if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
      return { type: entry.type === "directory" ? vscode.FileType.Directory : vscode.FileType.File, ctime: 0, mtime: Date.parse(entry.modifiedAt) || 0, size: entry.sizeBytes || 0 };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { deploymentId, path } = this.parseUri(uri);
    const result = await this.run("Downloading", () => this.api.listFiles(deploymentId, path));
    return (result.entries || []).map((entry) => {
      var child = this.join(path, entry.name);
      this.metadata.set(this.key(deploymentId, child), entry);
      return [entry.name, entry.type === "directory" ? vscode.FileType.Directory : vscode.FileType.File];
    });
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const { deploymentId, path } = this.parseUri(uri);
    var parent = path.substring(0, path.lastIndexOf("/")) || "/";
    var name = path.substring(path.lastIndexOf("/") + 1);
    if (!name) throw vscode.FileSystemError.NoPermissions(uri);
    await this.run("Updating remote files", () => this.api.createFolder(deploymentId, parent, name));
    this.invalidate(deploymentId, parent);
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Created, uri }]);
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { deploymentId, path } = this.parseUri(uri);

    const cacheKey = `${deploymentId}:${path}`;
    if (this.cache.has(cacheKey)) {
      return Buffer.from(this.cache.get(cacheKey)!);
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this.run("Downloading", () => this.api.readFile(deploymentId, path));

        let fullContent: string;
        if (result.hasMore) {
          try {
            fullContent = await this.run("Downloading", () => this.api.downloadFileContent(deploymentId, path));
          } catch (_dlErr) {
            fullContent = await this.run("Downloading", () => this.api.readFileAll(deploymentId, path));
          }
        } else {
          fullContent = result.content;
        }

        this.cache.set(cacheKey, fullContent);
        return Buffer.from(fullContent);
      } catch (error) {
        const transient = error instanceof ApiError && [502, 503, 504].includes(error.status || 0);
        const unavailable = error instanceof ApiError && [403, 404].includes(error.status || 0);
        if (!transient || attempt === 1 || unavailable) {
          throw new Error("Unable to open this remote file. It may have been deleted, moved, or you may not have access to it.");
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 800));
      }
    }
    throw new Error("Unable to read remote file.");
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    const { deploymentId, path } = this.parseUri(uri);
    const text = Buffer.from(content).toString("utf-8");
    await this.run("Uploading", async () => {
      await this.ensureCurrentBeforeWrite(uri, text, options);

      const UPLOAD_URL_THRESHOLD = 1 * 1024 * 1024;
      if (content.byteLength > UPLOAD_URL_THRESHOLD) {
        var uploaded = false;
        try {
          const parentDir = path.substring(0, path.lastIndexOf("/")) || "/";
          const fileName = path.substring(path.lastIndexOf("/") + 1);
          const upload = await this.api.getUploadUrl(deploymentId, parentDir);
          const formData = new FormData();
          const uploadBytes = new Uint8Array(content.byteLength);
          uploadBytes.set(content);
          const blob = new Blob([uploadBytes.buffer], { type: "application/octet-stream" });
          formData.append(upload.field || "files", blob, fileName);
          const res = await fetch(upload.url, { method: "POST", body: formData });
          if (!res.ok) {
            throw new Error("Upload failed (HTTP " + res.status + ")");
          }
          uploaded = true;
        } catch (_uploadErr: any) {
          // The signed upload may have succeeded before its response was lost.
          // Confirm the remote content before falling back to append chunks.
          try {
            var remoteAfterUpload = await this.api.downloadFileContent(deploymentId, path);
            uploaded = remoteAfterUpload === text;
          } catch (_verifyErr) { }
          if (!uploaded) {
            const CHUNK = 4 * 1024 * 1024;
            for (let i = 0; i < text.length; i += CHUNK) {
              const chunk = text.substring(i, i + CHUNK);
              await this.api.writeFile(deploymentId, path, chunk, i === 0 ? "overwrite" : "append");
            }
          }
        }
      } else {
        await this.api.writeFile(deploymentId, path, text);
      }

      this.cache.set(`${deploymentId}:${path}`, text);
      // Write responses do not include a modified timestamp. Refreshing it makes
      // the next save compare against the version we just created, not the
      // version that was present when the editor was opened.
      try {
        await this.updateFileMetadata(deploymentId, path);
      } catch (error) {
        // The upload has already succeeded. Keep its content baseline and let a
        // later save refresh metadata instead of reporting a false save failure.
        console.warn("[BB Files] Uploaded file but could not refresh its metadata", error);
      }
    });

    this._onDidChangeFile.fire([
      {
        type: vscode.FileChangeType.Changed,
        uri,
      },
    ]);
  }

  async delete(uri: vscode.Uri): Promise<void> {
    const { deploymentId, path } = this.parseUri(uri);
    if (path === "/") throw vscode.FileSystemError.NoPermissions(uri);
    var parent = path.substring(0, path.lastIndexOf("/")) || "/";
    var name = path.substring(path.lastIndexOf("/") + 1);
    await this.run("Updating remote files", () => this.api.deleteFile(deploymentId, parent, [name]));
    this.invalidate(deploymentId, path);
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const oldFile = this.parseUri(oldUri);
    const newFile = this.parseUri(newUri);
    if (oldFile.deploymentId !== newFile.deploymentId) throw vscode.FileSystemError.NoPermissions(oldUri);
    var root = oldFile.path.substring(0, oldFile.path.lastIndexOf("/")) || "/";
    var from = oldFile.path.substring(oldFile.path.lastIndexOf("/") + 1);
    var to = newFile.path.substring(newFile.path.lastIndexOf("/") + 1);
    if ((newFile.path.substring(0, newFile.path.lastIndexOf("/") || 1) || "/") !== root) {
      throw vscode.FileSystemError.NoPermissions(newUri);
    }
    await this.run("Updating remote files", () => this.api.renameFile(oldFile.deploymentId, root, from, to));
    this.invalidate(oldFile.deploymentId, oldFile.path);
    this.invalidate(newFile.deploymentId, newFile.path);
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri: oldUri }, { type: vscode.FileChangeType.Created, uri: newUri }]);
  }

  watch(uri: vscode.Uri): vscode.Disposable {
    var timer: ReturnType<typeof setInterval> | undefined;
    var disposed = false;
    var refresh = async () => {
      if (disposed) return;
      var parsed = this.parseUri(uri);
      try {
        var stat = await this.stat(uri);
        if (stat.type === vscode.FileType.File) {
          var wasChanged = await this.updateFileMetadata(parsed.deploymentId, parsed.path);
          if (wasChanged) {
            this.cache.delete(this.key(parsed.deploymentId, parsed.path));
            this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
          }
          return;
        }

        var entries = await this.api.listFiles(parsed.deploymentId, parsed.path);
        var changed = false;
        entries.entries.forEach((entry) => {
          var childPath = this.join(parsed.path, entry.name);
          var key = this.key(parsed.deploymentId, childPath);
          var previous = this.metadata.get(key);
          if (previous && this.entryChanged(previous, entry)) {
            this.cache.delete(key);
            changed = true;
          }
          this.metadata.set(key, entry);
        });
        if (changed) this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
      } catch (_e) { }
    };
    timer = setInterval(refresh, 30000);
    return new vscode.Disposable(() => { disposed = true; if (timer) clearInterval(timer); });
  }

  private parseUri(uri: vscode.Uri): { deploymentId: string; path: string } {
    const deploymentId = uri.authority;
    return { deploymentId: deploymentId, path: this.normalizePath(uri.path || "/") };
  }

  clearCache(): void {
    this.cache.clear();
    this.metadata.clear();
  }

  refresh(uri?: vscode.Uri): void {
    if (!uri) { this.clearCache(); return; }
    var parsed = this.parseUri(uri);
    this.invalidate(parsed.deploymentId, parsed.path);
    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  private async ensureCurrentBeforeWrite(uri: vscode.Uri, text: string, options: { create: boolean; overwrite: boolean }): Promise<void> {
    var parsed = this.parseUri(uri);
    var key = this.key(parsed.deploymentId, parsed.path);
    var known = this.metadata.get(key);
    if (!known || options.create && !options.overwrite) return;
    var parent = parsed.path.substring(0, parsed.path.lastIndexOf("/")) || "/";
    var name = parsed.path.substring(parsed.path.lastIndexOf("/") + 1);
    var current = (await this.api.listFiles(parsed.deploymentId, parent)).entries.find(function (entry) { return entry.name === name; });
    if (!current || current.modifiedAt === known.modifiedAt) return;
    var remote = await this.api.downloadFileContent(parsed.deploymentId, parsed.path);
    // Compare with the text the editor originally loaded (or last saved), not
    // with its pending text. Otherwise every second save is indistinguishable
    // from a competing remote edit: the pending text is expected to differ.
    var baseline = this.cache.get(key);
    this.metadata.set(key, current);
    if (remote === text || (baseline !== undefined && remote === baseline)) return;
    var choice = await vscode.window.showWarningMessage("Remote file changed since it was opened.", "Merge", "Overwrite", "Cancel");
    if (choice === "Overwrite") return;
    if (choice === "Merge") {
      var localUri = vscode.Uri.joinPath(vscode.Uri.file(require("os").tmpdir()), "bb-local-" + name);
      var remoteUri = vscode.Uri.joinPath(vscode.Uri.file(require("os").tmpdir()), "bb-remote-" + name);
      await vscode.workspace.fs.writeFile(localUri, Buffer.from(text));
      await vscode.workspace.fs.writeFile(remoteUri, Buffer.from(remote));
      await vscode.commands.executeCommand("vscode.diff", remoteUri, localUri, "Merge remote changes: " + name);
    }
    throw vscode.FileSystemError.FileExists(uri);
  }

  private normalizePath(value: string): string {
    var decoded = decodeURIComponent(value).replace(/\\/g, "/");
    var parts = decoded.split("/").filter(Boolean);
    var safe: string[] = [];
    parts.forEach(function (part) { if (part === "..") safe.pop(); else if (part !== ".") safe.push(part); });
    return "/" + safe.join("/");
  }

  private join(parent: string, name: string): string { return this.normalizePath((parent === "/" ? "" : parent) + "/" + name); }
  private key(deploymentId: string, path: string): string { return deploymentId + ":" + path; }
  private entryChanged(left: FileEntry, right: FileEntry): boolean {
    return left.modifiedAt !== right.modifiedAt || left.sizeBytes !== right.sizeBytes || left.hash !== right.hash || left.type !== right.type;
  }
  private async updateFileMetadata(deploymentId: string, path: string): Promise<boolean> {
    var parent = path.substring(0, path.lastIndexOf("/")) || "/";
    var name = path.substring(path.lastIndexOf("/") + 1);
    var current = (await this.api.listFiles(deploymentId, parent)).entries.find(function (entry) { return entry.name === name; });
    if (!current) return false;
    var key = this.key(deploymentId, path);
    var previous = this.metadata.get(key);
    this.metadata.set(key, current);
    return !!previous && this.entryChanged(previous, current);
  }
  private invalidate(deploymentId: string, path: string): void {
    var prefix = this.key(deploymentId, path);
    this.cache.delete(prefix);
    this.metadata.delete(prefix);
    this.metadata.forEach((_value, key) => { if (key.indexOf(prefix + "/") === 0) this.metadata.delete(key); });
  }
}
