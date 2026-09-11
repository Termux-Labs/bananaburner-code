import * as vscode from "vscode";
import { BotHostingApi, Deployment, FileEntry, EnvVar, StartupConfig, PackageInfo, BackupInfo, GitInfo } from "./api";
//
class LoadingItem extends vscode.TreeItem {
  constructor(message: string) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("loading~spin");
    this.description = "...";
    this.contextValue = "loading";
  }
}

class EmptyItem extends vscode.TreeItem {
  constructor(message: string, icon: string = "info") {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = "empty";
  }
}

class ActionItem extends vscode.TreeItem {
  constructor(label: string, command: string, icon: string, args?: any[]) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = { command: command, title: label, arguments: args || [] };
    this.contextValue = "action";
  }
}

export class ServerItem extends vscode.TreeItem {
  constructor(public readonly deployment: Deployment) {
    super(deployment.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon(this.getStateIcon(deployment.state));
    var badges: string[] = [];
    if (!deployment.owned) { badges.push("SHARED"); }
    if (deployment.state !== "running") { badges.push(deployment.state.toUpperCase()); }
    this.description = badges.length > 0 ? badges.join(" | ") : "";
    var lines: string[] = [];
    lines.push(deployment.name);
    lines.push("ID: " + deployment.id);
    lines.push("State: " + deployment.state);
    lines.push("Status: " + deployment.status);
    lines.push("Owner: " + (deployment.owner?.username || "unknown"));
    lines.push("Owned: " + (deployment.owned ? "Yes" : "No"));
    lines.push("RAM: " + deployment.resources?.ramMB + "MB | CPU: " + deployment.resources?.cpuPercent + "%");
    lines.push("Node: " + (deployment.node?.name || "N/A") + " (" + (deployment.node?.region || "N/A") + ")");
    if (deployment.shared?.length) {
      lines.push("Shared with: " + deployment.shared.map(function (s) { return s.user.username; }).join(", "));
    }
    this.tooltip = lines.join("\n");
    this.contextValue = "server";
  }

  private getStateIcon(state: string): string {
    switch (state) {
      case "running": return "pass";
      case "starting": return "loading~spin";
      case "stopping": return "warning";
      case "offline": return "circle-slash";
      case "installing": return "sync~spin";
      default: return "question";
    }
  }
}

export class SectionItem extends vscode.TreeItem {
  constructor(
    public readonly sectionName: string,
    public readonly deploymentId: string,
    icon: string
  ) {
    super(sectionName, vscode.TreeItemCollapsibleState.Collapsed);
    this.iconPath = new vscode.ThemeIcon(icon);
    var ctxMap: Record<string, string> = {
      "Files": "filesSection", "Env Variables": "envSection",
      "Startup": "startupSection", "Packages": "packagesSection",
      "Backups": "backupsSection", "Console": "consoleSection",
      "Git": "gitSection",
    };
    this.contextValue = ctxMap[sectionName] || "section";
  }
}

export class FileItem extends vscode.TreeItem {
  constructor(
    public readonly file: FileEntry,
    public readonly deploymentId: string,
    public readonly parentPath: string
  ) {
    super(file.name, vscode.TreeItemCollapsibleState.None);
    var fullPath = this.parentPath === "/" ? "/" + file.name : this.parentPath + "/" + file.name;
    this.resourceUri = vscode.Uri.parse("bh://" + deploymentId + fullPath);
    if (file.type === "directory") {
      this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
      this.iconPath = new vscode.ThemeIcon("folder");
      this.contextValue = "directory";
    } else {
      this.iconPath = this.getFileIcon(file.name);
      this.contextValue = "file";
      this.command = { command: "bb.openFile", title: "Open", arguments: [this] };
      if (file.sizeBytes > 0) { this.description = this.formatSize(file.sizeBytes); }
    }
  }

  private getFileIcon(name: string): vscode.ThemeIcon {
    var ext = name.split(".").pop()?.toLowerCase() || "";
    var iconMap: Record<string, string> = {
      ts: "file-code", tsx: "file-code", js: "file-code", jsx: "file-code",
      py: "file-code", rb: "file-code", go: "file-code", rs: "file-code",
      java: "file-code", cpp: "file-code", c: "file-code", h: "file-code",
      json: "json", yaml: "file-code", yml: "file-code", toml: "file-code",
      md: "markdown", txt: "file-text", png: "file-media", jpg: "file-media",
      zip: "file-zip", tar: "file-zip", gz: "file-zip",
    };
    return new vscode.ThemeIcon(iconMap[ext] || "file");
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }
}

export class EnvItem extends vscode.TreeItem {
  constructor(public readonly envVar: EnvVar, public readonly deploymentId: string) {
    super(envVar.key, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(envVar.secret ? "lock" : "symbol-variable");
    if (envVar.secret) {
      this.description = "***";
      this.tooltip = envVar.key + " (secret)";
    } else {
      this.description = envVar.value.length > 40 ? envVar.value.substring(0, 40) + "..." : envVar.value;
      this.tooltip = envVar.key + " = " + envVar.value;
    }
    if (envVar.system) { this.description = (this.description || "") + " (system)"; }
    this.contextValue = "envItem";
  }
}

export class StartupItem extends vscode.TreeItem {
  constructor(public readonly config: StartupConfig, deploymentId: string) {
    super("Startup Config", vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon("gear");
    this.description = config.runtime + " " + config.runtimeVersion;
    this.tooltip = [
      "Runtime: " + config.runtime,
      "Version: " + config.runtimeVersion,
      "Entry: " + config.entryFile,
      "Command: " + config.startCommand,
      "Kind: " + config.kind,
      "Engine: " + config.engine,
    ].join("\n");
    this.contextValue = "startupItem";
    this.command = { command: "bb.editStartup", title: "Edit Startup Configuration", arguments: [{ deploymentId: deploymentId }] };
  }
}

export class PackageItem extends vscode.TreeItem {
  constructor(public readonly pkg: { name: string; spec: string; dev: boolean }, public readonly deploymentId: string, public readonly manager: string) {
    super(pkg.name, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(pkg.dev ? "package" : "library");
    this.description = pkg.spec + (pkg.dev ? " (dev)" : "");
    this.contextValue = "packageItem";
  }
}

export class BackupItem extends vscode.TreeItem {
  constructor(public readonly backup: BackupInfo) {
    super(backup.label || backup.id.substring(0, 12), vscode.TreeItemCollapsibleState.None);
    var status = (backup.status || "unknown").toLowerCase();
    this.iconPath = new vscode.ThemeIcon(status === "active" || status === "completed" ? "pass" : status === "failed" || status === "error" ? "error" : "loading~spin");
    this.description = status === "active" || status === "completed" ? this.formatSize(backup.sizeBytes) + " | Ready" : this.formatSize(backup.sizeBytes) + " | " + backup.status;
    this.tooltip = [
      "ID: " + backup.id,
      "Label: " + backup.label,
      "Size: " + this.formatSize(backup.sizeBytes),
      "Status: " + backup.status,
      "Type: " + backup.backupType,
      "Files: " + backup.fileCount,
      "Created: " + backup.createdAt,
    ].join("\n");
    this.contextValue = "backupItem";
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  }
}

export class GitItem extends vscode.TreeItem {
  constructor(public readonly git: GitInfo, deploymentId: string) {
    super(git.linked ? git.repo : "Not linked", vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(git.linked ? "source-control" : "circle-slash");
    this.description = git.linked ? git.branch + (git.autoPull ? " (auto-pull)" : "") : "No GitHub linked";
    this.contextValue = "gitItem";
  }
}

export class ServerTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private deployments: Deployment[] = [];
  private fileCache: Map<string, FileEntry[]> = new Map();
  private envCache: Map<string, EnvVar[]> = new Map();
  private loading = false;
  private notAuthenticated = false;
  private readonly pendingLoads = new Map<string, Promise<void>>();
  private readonly sectionCache = new Map<string, { value: vscode.TreeItem[]; expiresAt: number }>();
  private readonly cacheTtlMs = 30_000;
  private readonly backupsCreating = new Set<string>();

  constructor(private api: BotHostingApi) { }

  refresh(): void {
    this.deployments = [];
    this.notAuthenticated = false;
    this.fileCache.clear();
    this.envCache.clear();
    this.sectionCache.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  setBackupCreating(deploymentId: string, creating: boolean): void {
    if (creating) this.backupsCreating.add(deploymentId);
    else this.backupsCreating.delete(deploymentId);
    this.sectionCache.delete("backups:" + deploymentId);
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem { return element; }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      if (this.notAuthenticated) {
        return [
          new ActionItem("Connect via OAuth", "bb.connect", "key"),
          new ActionItem("Connect via API Key", "bb.connectApiKey", "key")
        ];
      }
      return this.getDeployments();
    }

    if (element instanceof ServerItem) {
      return [
        new SectionItem("Files", element.deployment.id, "folder-opened"),
        new SectionItem("Env Variables", element.deployment.id, "symbol-variable"),
        new SectionItem("Startup", element.deployment.id, "gear"),
        new SectionItem("Packages", element.deployment.id, "library"),
        new SectionItem("Backups", element.deployment.id, "archive"),
        new SectionItem("Console", element.deployment.id, "terminal"),
        new SectionItem("Git", element.deployment.id, "source-control"),
      ];
    }

    if (element instanceof SectionItem) {
      switch (element.sectionName) {
        case "Files": return this.getFiles(element.deploymentId, "/");
        case "Env Variables": return this.getEnvVars(element.deploymentId);
        case "Startup": return this.getStartup(element.deploymentId);
        case "Packages": return this.getPackages(element.deploymentId);
        case "Backups": return this.getBackups(element.deploymentId);
        case "Console": return this.getConsoleItems(element.deploymentId);
        case "Git": return this.getGitItems(element.deploymentId);
      }
    }

    if (element instanceof FileItem && element.file.type === "directory") {
      var fullPath = element.parentPath === "/" ? "/" + element.file.name : element.parentPath + "/" + element.file.name;
      return this.getFiles(element.deploymentId, fullPath);
    }

    return [];
  }

  private async getDeployments(): Promise<vscode.TreeItem[]> {
    if (this.deployments.length > 0) {
      var items = this.deployments.map(function (d) { return new ServerItem(d); });
      return items;
    }
    var skeleton = this.makeSkeleton(4);
    this.fetchDeploymentsInBackground();
    return skeleton;
  }

  private async fetchDeploymentsInBackground(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      this.deployments = await this.api.listDeployments();
      this.deployments.sort(function (a, b) {
        if (a.owned !== b.owned) return a.owned ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      this._onDidChangeTreeData.fire(undefined);
    } catch (err: any) {
      if (err.message && (err.message.indexOf("Not authenticated") !== -1 || err.message.indexOf("Token expired") !== -1)) {
        this.notAuthenticated = true;
        this._onDidChangeTreeData.fire(undefined);
      } else {
        vscode.window.showErrorMessage("Failed to load deployments: " + err.message);
      }
    } finally {
      this.loading = false;
    }
  }

  private async getFiles(deploymentId: string, path: string): Promise<vscode.TreeItem[]> {
    var cacheKey = deploymentId + ":" + path;
    if (this.fileCache.has(cacheKey)) {
      var cached = this.fileCache.get(cacheKey)!;
      var cachedItems = cached.map(function (e) { return new FileItem(e, deploymentId, path); });
      return cachedItems;
    }
    var skeleton = this.makeSkeleton(3);
    this.fetchFilesInBackground(deploymentId, path, cacheKey);
    return skeleton;
  }

  private async fetchFilesInBackground(deploymentId: string, path: string, cacheKey: string): Promise<void> {
    if (this.pendingLoads.has(cacheKey)) return this.pendingLoads.get(cacheKey)!;
    var load = this.loadFiles(deploymentId, path, cacheKey);
    this.pendingLoads.set(cacheKey, load);
    try { await load; } finally { this.pendingLoads.delete(cacheKey); }
  }

  private async loadFiles(deploymentId: string, path: string, cacheKey: string): Promise<void> {
    try {
      var result = await this.api.listFiles(deploymentId, path);
      var entries = result.entries || [];
      entries.sort(function (a, b) {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      this.fileCache.set(cacheKey, entries);
      this._onDidChangeTreeData.fire(undefined);
    } catch (err: any) {
      vscode.window.showErrorMessage("Failed to list files: " + err.message);
    }
  }

  private async getEnvVars(deploymentId: string): Promise<vscode.TreeItem[]> {
    if (this.envCache.has(deploymentId)) {
      return this.envCache.get(deploymentId)!.map(function (v) { return new EnvItem(v, deploymentId); });
    }
    var skeleton = this.makeSkeleton(3);
    this.fetchEnvInBackground(deploymentId);
    return skeleton;
  }

  private async fetchEnvInBackground(deploymentId: string): Promise<void> {
    var key = "env:" + deploymentId;
    if (this.pendingLoads.has(key)) return this.pendingLoads.get(key)!;
    var load = this.loadEnv(deploymentId);
    this.pendingLoads.set(key, load);
    try { await load; } finally { this.pendingLoads.delete(key); }
  }

  private async loadEnv(deploymentId: string): Promise<void> {
    try {
      var result = await this.api.listEnv(deploymentId);
      this.envCache.set(deploymentId, result.variables || []);
      this._onDidChangeTreeData.fire(undefined);
    } catch (err: any) {
      vscode.window.showErrorMessage("Failed to load env vars: " + err.message);
    }
  }

  private async getStartup(deploymentId: string): Promise<vscode.TreeItem[]> {
    return this.getSection("startup:" + deploymentId, async () => [new StartupItem(await this.api.getStartup(deploymentId), deploymentId)]);
  }

  private async getPackages(deploymentId: string): Promise<vscode.TreeItem[]> {
    return this.getSection("packages:" + deploymentId, async () => {
      try {
        var items: vscode.TreeItem[] = [new ActionItem("Add Package", "bb.addPackage", "add", [deploymentId])];
        var result = await this.api.listPackages(deploymentId, "npm");
        if (!result.exists || result.packages.length === 0) {
          var pipResult = await this.api.listPackages(deploymentId, "pip");
          if (pipResult.exists && pipResult.packages.length > 0) {
            for (var i = 0; i < pipResult.packages.length; i++) {
              items.push(new PackageItem(pipResult.packages[i], deploymentId, "pip"));
            }
            return items;
          }
          items.push(new EmptyItem("No packages installed", "library"));
          return items;
        }
        for (var i = 0; i < result.packages.length; i++) {
          items.push(new PackageItem(result.packages[i], deploymentId, "npm"));
        }
        return items;
      } catch (_e) {
        return [new EmptyItem("Failed to load", "warning")];
      }
    });
  }

  private async getBackups(deploymentId: string): Promise<vscode.TreeItem[]> {
    return this.getSection("backups:" + deploymentId, async () => {
      try {
        var result = await this.api.listBackups(deploymentId);
        var backups = result.backups || [];
        var items: vscode.TreeItem[] = [];
        if (this.backupsCreating.has(deploymentId)) {
          var creating = new vscode.TreeItem("Creating backup…", vscode.TreeItemCollapsibleState.None);
          creating.iconPath = new vscode.ThemeIcon("loading~spin");
          creating.description = "Please wait";
          creating.tooltip = "A backup is currently being created for this deployment.";
          creating.contextValue = "backupCreating";
          items.push(creating);
        } else {
          items.push(new ActionItem("Create Backup", "bb.createBackup", "add", [deploymentId]));
        }
        if (backups.length === 0) {
          items.push(new EmptyItem("No backups", "archive"));
          return items;
        }
        for (var i = 0; i < backups.length; i++) {
          items.push(new BackupItem(backups[i]));
        }
        return items;
      } catch (_e) {
        return [new EmptyItem("Failed to load", "warning")];
      }
    });
  }

  private async getConsoleItems(deploymentId: string): Promise<vscode.TreeItem[]> {
    var item = new vscode.TreeItem("Open Console", vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon("terminal");
    item.command = { command: "bb.openConsole", title: "Open Console", arguments: [deploymentId] };
    item.contextValue = "consoleOpen";
    return [item];
  }

  private async getGitItems(deploymentId: string): Promise<vscode.TreeItem[]> {
    return this.getSection("git:" + deploymentId, async () => {
      try { return [new GitItem(await this.api.getGit(deploymentId), deploymentId)]; }
      catch (_e) { return [new EmptyItem("Failed to load Git details", "warning")]; }
    });
  }

  private async getSection(key: string, loader: () => Promise<vscode.TreeItem[]>): Promise<vscode.TreeItem[]> {
    var cached = this.sectionCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    var pending = this.pendingLoads.get(key);
    if (pending) return [new LoadingItem("Loading")];
    var load = (async () => {
      var value = await loader();
      this.sectionCache.set(key, { value: value, expiresAt: Date.now() + this.cacheTtlMs });
      this._onDidChangeTreeData.fire(undefined);
    })();
    this.pendingLoads.set(key, load);
    try { await load; return this.sectionCache.get(key)!.value; }
    finally { this.pendingLoads.delete(key); }
  }

  private makeSkeleton(count: number): vscode.TreeItem[] {
    var items: vscode.TreeItem[] = [];
    for (var i = 0; i < count; i++) { items.push(new LoadingItem("Loading")); }
    return items;
  }

  getDeployment(id: string): Deployment | undefined {
    return this.deployments.find(function (d) { return d.id === id; });
  }

  getDeploymentList(): Deployment[] {
    return this.deployments;
  }
}
