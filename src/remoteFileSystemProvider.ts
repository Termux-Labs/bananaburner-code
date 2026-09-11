import * as vscode from "vscode";
import { ApiError, BotHostingApi } from "./api";
//
export class RemoteFileSystemProvider implements vscode.FileSystemProvider {
  private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  private cache: Map<string, string> = new Map();

  constructor(private api: BotHostingApi) { }

  stat(uri: vscode.Uri): vscode.FileStat {
    const { deploymentId, path } = this.parseUri(uri);

    if (path === "/" || path === "") {
      return {
        type: vscode.FileType.Directory,
        ctime: Date.now(),
        mtime: Date.now(),
        size: 0,
      };
    }

    return {
      type: vscode.FileType.File,
      ctime: Date.now(),
      mtime: Date.now(),
      size: 0,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { deploymentId, path } = this.parseUri(uri);
    const result = await this.api.listFiles(deploymentId, path);
    return (result.entries || []).map((entry) => [
      entry.name,
      entry.type === "directory" ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  }

  createDirectory(uri: vscode.Uri): void {
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { deploymentId, path } = this.parseUri(uri);

    const cacheKey = `${deploymentId}:${path}`;
    if (this.cache.has(cacheKey)) {
      return Buffer.from(this.cache.get(cacheKey)!);
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await this.api.readFile(deploymentId, path);

        let fullContent: string;
        if (result.hasMore) {
          try {
            fullContent = await this.api.downloadFileContent(deploymentId, path);
          } catch (_dlErr) {
            fullContent = await this.api.readFileAll(deploymentId, path);
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

    const UPLOAD_URL_THRESHOLD = 1 * 1024 * 1024;
    if (content.byteLength > UPLOAD_URL_THRESHOLD) {
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
      } catch (uploadErr: any) {
        const CHUNK = 4 * 1024 * 1024;
        for (let i = 0; i < text.length; i += CHUNK) {
          const chunk = text.substring(i, i + CHUNK);
          await this.api.writeFile(deploymentId, path, chunk, i === 0 ? "overwrite" : "append");
        }
      }
    } else {
      await this.api.writeFile(deploymentId, path, text);
    }

    this.cache.set(`${deploymentId}:${path}`, text);

    this._onDidChangeFile.fire([
      {
        type: vscode.FileChangeType.Changed,
        uri,
      },
    ]);
  }

  delete(uri: vscode.Uri): void {
  }

  rename(oldUri: vscode.Uri, newUri: vscode.Uri): void {
  }

  watch(_uri: vscode.Uri): vscode.Disposable {
    return new vscode.Disposable(() => { });
  }

  private parseUri(uri: vscode.Uri): { deploymentId: string; path: string } {
    const deploymentId = uri.authority;
    let path = uri.path || "/";

    path = decodeURIComponent(path);

    return { deploymentId, path };
  }

  clearCache(): void {
    this.cache.clear();
  }
}
