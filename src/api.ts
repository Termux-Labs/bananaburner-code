import * as vscode from "vscode";

const API_BASE = "https://bot-hosting.net/api/v1";
//
export class ApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "ApiError";
  }
}

export interface Deployment {
  id: string;
  name: string;
  description: string;
  state: "running" | "starting" | "stopping" | "offline" | "installing" | "unknown";
  status: string;
  createdAt: string;
  owned: boolean;
  owner: { id: string; username: string };
  shared: { user: { id: string; username: string }; permissions: string[] }[];
  resources: { ramMB: number; cpuPercent: number; storageMB: number };
  domains: { subdomain: string; slug: string; custom: string };
  node: { name: string; fqdn: string; region: string } | null;
  port: number | null;
  ports: number[];
}

export interface StartupConfig {
  kind: string;
  runtime: string;
  runtimeVersion: string;
  entryFile: string;
  startCommand: string;
  engine: string;
}

export interface GitInfo {
  linked: boolean;
  repo: string;
  branch: string;
  autoPull: boolean;
}

export interface RuntimeInfo {
  id: string;
  label: string;
  versions: string[];
  defaultVersion: string;
  defaultEntry: string;
}

export interface ResourceUsage {
  state: string;
  cpu: { usedPercent: number; limitPercent: number };
  memory: { usedBytes: number; limitBytes: number };
  disk: { usedBytes: number; limitBytes: number };
  network: { rxBytes: number; txBytes: number };
  uptimeMs: number;
}

export interface LogOutput {
  lines: string[];
}

export interface FileReadResult {
  path: string;
  content: string;
  offset: number;
  lines: number;
  totalLines: number;
  hasMore: boolean;
  note?: string;
}

export interface FileWriteResult {
  ok: boolean;
  path: string;
  bytes?: number;
  lines?: number;
  note?: string;
  hint?: string;
}

export interface DownloadUrlResult {
  url: string;
  expiresAt?: string;
}

export interface UploadUrlResult {
  url: string;
  field?: string;
  expiresAt?: string;
}

export interface PackageInfo {
  manager: string;
  file: string;
  exists: boolean;
  packages: { name: string; spec: string; dev: boolean }[];
}

export interface BackupInfo {
  id: string;
  deploymentId: string;
  label: string;
  sizeBytes: number;
  status: string;
  backupType: string;
  fileCount: number;
  isOrphaned: boolean;
  createdAt: string;
  completedAt: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  description: string;
  isOwner: boolean;
  createdAt: string;
}

export interface TemplateInfo {
  id: string;
  slug: string;
  name: string;
  tagline: string;
  category: string;
  runtime: string;
  githubRepo: string;
  githubStars: number;
  deployCount: number;
  owner: { username: string; avatar: string };
}

export interface FileEntry {
  name: string;
  type: "file" | "directory";
  sizeBytes: number;
  modifiedAt: string;
  mode: string;
}

export interface EnvVar {
  key: string;
  value: string;
  secret: boolean;
  system: boolean;
}

export interface AccountInfo {
  id: string;
  username: string;
  email: string;
  createdAt: string;
  creditsCents: number;
  quota: {
    pool: { ramMB: number; cpuPct: number; storageMB: number; slots: number };
    used: { ramMB: number; cpuPct: number; storageMB: number; slots: number };
  };
}

export class BotHostingApi {
  private getToken: () => Promise<string | undefined>;
  private remaining = 120;
  private resetAt = 0;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(getToken: () => Promise<string | undefined>) {
    this.getToken = getToken;
  }

  private trackRateLimit(headers: Headers): void {
    var remaining = headers.get("X-RateLimit-Remaining");
    if (remaining !== null) {
      this.remaining = parseInt(remaining, 10);
    }
    var reset = headers.get("X-RateLimit-Reset");
    if (reset) {
      var resetValue = Number(reset);
      if (Number.isFinite(resetValue)) {
        this.resetAt = resetValue > 1000000000 ? resetValue * 1000 : Date.now() + resetValue * 1000;
      }
    }
  }

  private async waitIfNeeded(): Promise<void> {
    if (this.remaining <= 5 && Date.now() < this.resetAt) {
      var waitMs = this.resetAt - Date.now() + 1000;
      await new Promise(function (r) { setTimeout(r, waitMs); });
    }
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    var method = (options.method || "GET").toUpperCase();
    var key = method + ":" + path;
    if (method === "GET") {
      var existing = this.inFlight.get(key);
      if (existing) return existing as Promise<T>;
      var pending = this.doRequest<T>(path, options).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
      return pending;
    }
    return this.doRequest<T>(path, options);
  }

  private async doRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
    var token = await this.getToken();
    if (!token) { console.log("[BB API] BLOCKED: Not authenticated, path=", path); throw new Error("Not authenticated"); }
    await this.waitIfNeeded();
    var url = API_BASE + path;
    var method = (options.method || "GET").toUpperCase();
    console.log("[BB API]", method, path);
    var res = await fetch(url, {
      ...options,
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...options.headers },
    });
    this.trackRateLimit(res.headers);
    console.log("[BB API]", method, path, "→", res.status);
    if (res.status === 401) {
      vscode.commands.executeCommand("bb.reAuthenticate");
      throw new Error("Token expired");
    }
    if (res.status === 403) {
      var forbiddenBody = await res.text();
      var forbiddenMessage = forbiddenBody;
      try {
        var forbiddenParsed = JSON.parse(forbiddenBody);
        var forbiddenError = forbiddenParsed?.error;
        forbiddenMessage = forbiddenError?.message || forbiddenParsed?.message || (typeof forbiddenError === "string" ? forbiddenError : forbiddenBody);
      } catch (_e) { }
      forbiddenMessage = String(forbiddenMessage || "The server did not provide an error message.").trim().slice(0, 500);
      var permissionError = "Permission denied. Your API key or OAuth token may lack required scopes. API response: " + forbiddenMessage;
      vscode.window.showErrorMessage(permissionError, "Re-authenticate").then(function (choice) {
        if (choice === "Re-authenticate") { vscode.commands.executeCommand("bb.reAuthenticate"); }
      });
      throw new ApiError(permissionError, 403);
    }
    if (res.status === 429) {
      var retryAfter = res.headers.get("Retry-After");
      var waitSec = retryAfter ? parseInt(retryAfter, 10) : 60;
      this.resetAt = Date.now() + waitSec * 1000;
      this.remaining = 0;
      throw new Error("Rate limited. Retry after " + waitSec + "s");
    }
    if (!res.ok) {
      var body = await res.text();
      if (res.status >= 500) {
        throw new ApiError("Bot-Hosting is temporarily unavailable (HTTP " + res.status + "). Please try again shortly.", res.status);
      }
      var message = body;
      try {
        var parsed = JSON.parse(body);
        message = parsed?.error?.message || parsed?.message || body;
      } catch (_e) {
        if (body.trim().startsWith("<")) message = "The hosting service returned an unexpected error page.";
      }
      throw new ApiError("API " + res.status + ": " + String(message).slice(0, 300), res.status);
    }
    return res.json() as Promise<T>;
  }


  private unwrap<T>(data: T): T {
    if (data && typeof data === "object") {
      var value = data as any;
      if (value.deployment !== undefined) return value.deployment as T;
      if (value.resources !== undefined) return value.resources as T;
      if (value.data !== undefined) return value.data as T;
    }
    return data as T;
  }

  async listDeployments(): Promise<Deployment[]> {
    var data = await this.request<{ deployments?: Deployment[]; data?: Deployment[] }>("/deployments");
    var payload = this.unwrap(data) as any;
    return data.deployments || (Array.isArray(payload) ? payload : payload?.deployments) || [];
  }

  async getDeployment(id: string): Promise<Deployment> {
    var data = await this.request<Deployment | { deployment: Deployment }>("/deployments/" + id);
    return this.unwrap(data) as Deployment;
  }

  async updateDeployment(id: string, name?: string, description?: string): Promise<Deployment> {
    var body: any = {};
    if (name !== undefined) { body.name = name; }
    if (description !== undefined) { body.description = description; }
    var data = await this.request<Deployment | { deployment: Deployment }>("/deployments/" + id, { method: "PATCH", body: JSON.stringify(body) });
    return this.unwrap(data) as Deployment;
  }

  async deleteDeployment(id: string): Promise<{ ok: boolean }> {
    return this.request("/deployments/" + id, { method: "DELETE" });
  }

  async moveDeployment(id: string, toProjectId: string): Promise<Deployment> {
    return this.request("/deployments/" + id + "/move", { method: "POST", body: JSON.stringify({ toProjectId: toProjectId }) });
  }


  async getStartup(id: string): Promise<StartupConfig> {
    return this.request("/deployments/" + id + "/startup");
  }

  async updateStartup(id: string, config: { runtime?: string; runtimeVersion?: string; entryFile?: string; startCommand?: string; kind?: string; engine?: string }): Promise<StartupConfig> {
    return this.request("/deployments/" + id + "/startup", { method: "PATCH", body: JSON.stringify(config) });
  }

  async listRuntimes(): Promise<{ runtimes: RuntimeInfo[]; services: RuntimeInfo[]; databases: { id: string; label: string; versions: string[]; defaultVersion: string }[] }> {
    return this.request("/runtimes");
  }


  async getGit(id: string): Promise<GitInfo> {
    return this.request("/deployments/" + id + "/git");
  }

  async setAutoPull(id: string, autoPull: boolean): Promise<GitInfo> {
    return this.request("/deployments/" + id + "/git", { method: "PATCH", body: JSON.stringify({ autoPull: autoPull }) });
  }

  async syncDeployment(id: string): Promise<{ ok: boolean; commit: string }> {
    return this.request("/deployments/" + id + "/sync", { method: "POST" });
  }


  async powerAction(id: string, action: "start" | "stop" | "restart" | "kill"): Promise<{ ok: boolean; action: string }> {
    return this.request("/deployments/" + id + "/power", { method: "POST", body: JSON.stringify({ action: action }) });
  }

  async getLogs(id: string, size?: number): Promise<LogOutput> {
    var query = size ? "?size=" + size : "";
    return this.request("/deployments/" + id + "/logs" + query);
  }

  async sendCommand(id: string, command: string): Promise<{ ok: boolean }> {
    return this.request("/deployments/" + id + "/command", { method: "POST", body: JSON.stringify({ command: command }) });
  }

  async getResources(id: string): Promise<ResourceUsage> {
    var data = await this.request<ResourceUsage | { resources: ResourceUsage }>("/deployments/" + id + "/resources");
    var resources = this.unwrap(data) as Partial<ResourceUsage>;
    return {
      state: resources.state || "unknown",
      cpu: resources.cpu || { usedPercent: 0, limitPercent: 0 },
      memory: resources.memory || { usedBytes: 0, limitBytes: 0 },
      disk: resources.disk || { usedBytes: 0, limitBytes: 0 },
      network: resources.network || { rxBytes: 0, txBytes: 0 },
      uptimeMs: Number.isFinite(resources.uptimeMs) ? resources.uptimeMs! : 0,
    };
  }

  async resize(id: string, ramMB: number, cpuPct: number, storageMB: number): Promise<Deployment> {
    var data = await this.request<Deployment | { deployment: Deployment }>("/deployments/" + id + "/resize", { method: "PATCH", body: JSON.stringify({ ramMB: ramMB, cpuPct: cpuPct, storageMB: storageMB }) });
    return this.unwrap(data) as Deployment;
  }


  async listFiles(deploymentId: string, path: string = "/"): Promise<{ path: string; entries: FileEntry[] }> {
    var query = new URLSearchParams({ path: path });
    return this.request("/deployments/" + deploymentId + "/files?" + query);
  }

  async readFile(deploymentId: string, path: string, offset?: number, limit?: number): Promise<FileReadResult> {
    var params: Record<string, string> = { path: path };
    if (offset !== undefined) { params.offset = String(offset); }
    if (limit !== undefined) { params.limit = String(limit); }
    var query = new URLSearchParams(params);
    return this.request("/deployments/" + deploymentId + "/files/content?" + query);
  }

  async readFileAll(deploymentId: string, path: string): Promise<string> {
    var offset = 0;
    var limit = 400;
    var chunks: string[] = [];
    for (var page = 0; page < 500; page++) {
      var result = await this.readFile(deploymentId, path, offset, limit);
      chunks.push(result.content);
      if (!result.hasMore) break;
      offset += result.lines;
    }
    return chunks.join("\n");
  }

  async downloadFileContent(deploymentId: string, path: string): Promise<string> {
    var token = await this.getToken();
    if (!token) { throw new Error("Not authenticated"); }
    var urlResult = await this.getDownloadUrl(deploymentId, path);
    var res = await fetch(urlResult.url);
    if (!res.ok) {
      throw new ApiError("Download failed (HTTP " + res.status + ")", res.status);
    }
    return res.text();
  }

  async writeFile(deploymentId: string, path: string, content: string, mode?: "overwrite" | "append"): Promise<FileWriteResult> {
    var body: any = { path: path, content: content };
    if (mode) { body.mode = mode; }
    return this.request("/deployments/" + deploymentId + "/files/content", { method: "POST", body: JSON.stringify(body) });
  }

  async createFolder(deploymentId: string, root: string, name: string): Promise<{ ok: boolean }> {
    return this.request("/deployments/" + deploymentId + "/files/folder", { method: "POST", body: JSON.stringify({ root: root, name: name }) });
  }

  async deleteFile(deploymentId: string, root: string, files: string[]): Promise<{ ok: boolean; deleted: number }> {
    return this.request("/deployments/" + deploymentId + "/files/delete", { method: "POST", body: JSON.stringify({ root: root, files: files }) });
  }

  async renameFile(deploymentId: string, root: string, from: string, to: string): Promise<{ ok: boolean }> {
    return this.request("/deployments/" + deploymentId + "/files/rename", { method: "POST", body: JSON.stringify({ root: root, from: from, to: to }) });
  }

  async copyFile(deploymentId: string, location: string): Promise<{ ok: boolean }> {
    return this.request("/deployments/" + deploymentId + "/files/copy", { method: "POST", body: JSON.stringify({ location: location }) });
  }

  async chmodFile(deploymentId: string, root: string, file: string, mode: string): Promise<{ ok: boolean }> {
    return this.request("/deployments/" + deploymentId + "/files/chmod", { method: "POST", body: JSON.stringify({ root: root, file: file, mode: mode }) });
  }

  async compressFiles(deploymentId: string, root: string, files: string[]): Promise<{ ok: boolean; archive: string }> {
    return this.request("/deployments/" + deploymentId + "/files/compress", { method: "POST", body: JSON.stringify({ root: root, files: files }) });
  }

  async decompressFile(deploymentId: string, root: string, file: string): Promise<{ ok: boolean }> {
    return this.request("/deployments/" + deploymentId + "/files/decompress", { method: "POST", body: JSON.stringify({ root: root, file: file }) });
  }

  async getDownloadUrl(deploymentId: string, path: string): Promise<DownloadUrlResult> {
    var query = new URLSearchParams({ path: path });
    return this.request("/deployments/" + deploymentId + "/files/download-url?" + query);
  }

  async getUploadUrl(deploymentId: string, path?: string): Promise<UploadUrlResult> {
    var body: any = {};
    if (path) { body.path = path; }
    return this.request("/deployments/" + deploymentId + "/files/upload-url", { method: "POST", body: JSON.stringify(body) });
  }


  async listEnv(deploymentId: string): Promise<{ variables: EnvVar[] }> {
    return this.request("/deployments/" + deploymentId + "/env");
  }

  async setEnv(deploymentId: string, key: string, value: string, secret: boolean = false): Promise<{ ok: boolean; key: string }> {
    return this.request("/deployments/" + deploymentId + "/env", { method: "POST", body: JSON.stringify({ key: key, value: value, secret: secret }) });
  }

  async updateEnv(deploymentId: string, key: string, newKey?: string, value?: string, secret?: boolean): Promise<{ ok: boolean; key: string }> {
    var body: any = {};
    if (newKey !== undefined) { body.newKey = newKey; }
    if (value !== undefined) { body.value = value; }
    if (secret !== undefined) { body.secret = secret; }
    return this.request("/deployments/" + deploymentId + "/env/" + key, { method: "PATCH", body: JSON.stringify(body) });
  }

  async deleteEnv(deploymentId: string, key: string): Promise<{ ok: boolean }> {
    return this.request("/deployments/" + deploymentId + "/env/" + key, { method: "DELETE" });
  }


  async listPackages(deploymentId: string, manager: string): Promise<PackageInfo> {
    return this.request("/deployments/" + deploymentId + "/packages?manager=" + manager);
  }

  async addPackage(deploymentId: string, manager: string, name: string, spec?: string, dev?: boolean): Promise<PackageInfo> {
    var body: any = { manager: manager, name: name };
    if (spec !== undefined) { body.spec = spec; }
    if (dev !== undefined) { body.dev = dev; }
    return this.request("/deployments/" + deploymentId + "/packages", { method: "POST", body: JSON.stringify(body) });
  }

  async removePackage(deploymentId: string, manager: string, name: string): Promise<PackageInfo> {
    return this.request("/deployments/" + deploymentId + "/packages/remove", { method: "POST", body: JSON.stringify({ manager: manager, name: name }) });
  }


  async listBackups(deploymentId: string): Promise<{ backups: BackupInfo[] }> {
    return this.request("/deployments/" + deploymentId + "/backups");
  }

  async createBackup(deploymentId: string): Promise<{ ok: boolean; backupId: string }> {
    return this.request("/deployments/" + deploymentId + "/backups", { method: "POST" });
  }

  async getBackup(backupId: string): Promise<BackupInfo> {
    return this.request("/backups/" + backupId);
  }

  async deleteBackup(backupId: string): Promise<{ ok: boolean }> {
    return this.request("/backups/" + backupId, { method: "DELETE" });
  }

  async restoreBackup(backupId: string, deploymentId: string, startAfter?: boolean): Promise<{ ok: boolean; warning?: string }> {
    var body: any = { deploymentId: deploymentId };
    if (startAfter !== undefined) { body.startAfter = startAfter; }
    return this.request("/backups/" + backupId + "/restore", { method: "POST", body: JSON.stringify(body) });
  }


  async listProjects(): Promise<{ projects: ProjectInfo[] }> {
    return this.request("/projects");
  }

  async createProject(name: string, description?: string): Promise<ProjectInfo> {
    var body: any = { name: name };
    if (description !== undefined) { body.description = description; }
    return this.request("/projects", { method: "POST", body: JSON.stringify(body) });
  }

  async deleteProject(id: string): Promise<{ ok: boolean }> {
    return this.request("/projects/" + id, { method: "DELETE" });
  }


  async enableDomains(id: string): Promise<{ subdomain: string }> {
    return this.request("/deployments/" + id + "/domains", { method: "POST" });
  }

  async setSlug(id: string, slug: string): Promise<{ ok: boolean }> {
    return this.request("/deployments/" + id + "/domains/slug", { method: "PATCH", body: JSON.stringify({ slug: slug }) });
  }

  async removeSlug(id: string): Promise<{ ok: boolean }> {
    return this.request("/deployments/" + id + "/domains/slug", { method: "DELETE" });
  }

  async setCustomDomain(id: string, domain: string): Promise<{ token: string }> {
    return this.request("/deployments/" + id + "/domains/custom", { method: "PATCH", body: JSON.stringify({ domain: domain }) });
  }

  async verifyCustomDomain(id: string): Promise<{ verified: boolean; reason?: string }> {
    return this.request("/deployments/" + id + "/domains/custom/verify", { method: "POST" });
  }

  async removeCustomDomain(id: string): Promise<{ ok: boolean }> {
    return this.request("/deployments/" + id + "/domains/custom", { method: "DELETE" });
  }


  async listTemplates(sort?: string, category?: string, q?: string): Promise<{ total: number; items: TemplateInfo[] }> {
    var params = new URLSearchParams();
    if (sort) { params.set("sort", sort); }
    if (category) { params.set("category", category); }
    if (q) { params.set("q", q); }
    var qs = params.toString();
    return this.request("/templates" + (qs ? "?" + qs : ""));
  }


  async getAccount(): Promise<AccountInfo> {
    return this.request("/account");
  }
}
