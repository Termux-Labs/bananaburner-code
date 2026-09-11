import * as vscode from "vscode";
import * as crypto from "crypto";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { URL } from "url";

const CLIENT_ID = "bhc_76a5fbc39adc8c874737a75e1d1e307680bc18fe58b9d28de917123530e7b6cf";
const AUTH_SERVER = "https://bot-hosting.net";
const TOKEN_URL = "https://bot-hosting.net/api/oauth/token";
const REDIRECT_PORT = 49321;
const REDIRECT_URI = "http://127.0.0.1:" + REDIRECT_PORT + "/callback";

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}
//
export type AuthMethod = "oauth" | "apikey";

export class AuthManager {
  private tokenSet: TokenSet | undefined;
  private secrets: vscode.SecretStorage;
  private authMethod: AuthMethod = "oauth";
  private readonly brandIcon: string;

  constructor(secrets: vscode.SecretStorage, extensionPath?: string) {
    this.secrets = secrets;
    try {
      const icon = fs.readFileSync(path.join(extensionPath || "", "icons", "icon128.png"));
      this.brandIcon = "data:image/png;base64," + icon.toString("base64");
    } catch {
      this.brandIcon = "";
    }
  }

  private base64url(buf: Buffer): string {
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  private generateCodeVerifier(): string {
    return this.base64url(crypto.randomBytes(32));
  }

  private generateCodeChallenge(verifier: string): string {
    return this.base64url(crypto.createHash("sha256").update(verifier).digest());
  }

  private generateState(): string {
    return this.base64url(crypto.randomBytes(16));
  }

  async loadTokens(): Promise<TokenSet | undefined> {
    const raw = await this.secrets.get("bb_tokens");
    if (!raw) return undefined;

    this.tokenSet = JSON.parse(raw) as TokenSet;

    if (this.tokenSet && Date.now() >= this.tokenSet.expiresAt) {
      try {
        this.tokenSet = await this.refreshTokens(this.tokenSet.refreshToken);
        await this.secrets.store("bb_tokens", JSON.stringify(this.tokenSet));
      } catch {
        this.tokenSet = undefined;
      }
    }
    return this.tokenSet;
  }

  async getToken(): Promise<string | undefined> {
    const method = await this.getAuthMethod();
    if (method === "apikey") {
      return this.secrets.get("bb_apikey");
    }
    const tokens = await this.loadTokens();
    return tokens?.accessToken;
  }

  async getAuthMethod(): Promise<AuthMethod> {
    const apiKey = await this.secrets.get("bb_apikey");
    if (apiKey) return "apikey";
    const tokens = await this.secrets.get("bb_tokens");
    if (tokens) return "oauth";
    return this.authMethod;
  }

  async isAuthenticated(): Promise<boolean> {
    const token = await this.getToken();
    return !!token;
  }

  async loginOAuth(): Promise<void> {
    this.authMethod = "oauth";
    const verifier = this.generateCodeVerifier();
    const challenge = this.generateCodeChallenge(verifier);
    const state = this.generateState();

    const authUrl = new URL(AUTH_SERVER + "/oauth/authorize");
    authUrl.searchParams.set("client_id", CLIENT_ID);
    authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set(
      "scope",
      "deployments:read deployments:power deployments:write projects:read projects:write files:read files:write env:read env:write backups:read backups:write packages:read packages:write account:read billing:read templates:read"
    );
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);

    const code = await this.waitForCallback(state, () => {
      void vscode.env.openExternal(vscode.Uri.parse(authUrl.toString()));
    });
    if (!code) {
      throw new Error("Authorization cancelled or failed");
    }

    this.tokenSet = await this.exchangeCode(code, verifier);
    await this.secrets.store("bb_tokens", JSON.stringify(this.tokenSet));
  }

  async loginApiKey(): Promise<void> {
    this.authMethod = "apikey";
    const key = await vscode.window.showInputBox({
      prompt: "Enter your Bot-Hosting API key (bhk_...)",
      placeHolder: "bhk_...",
      password: true,
      validateInput: (v) => {
        if (!v || !v.startsWith("bhk_")) {
          return "API key must start with bhk_";
        }
        return null;
      },
    });
    if (!key) {
      throw new Error("No API key provided");
    }

    await this.secrets.store("bb_apikey", key);
  }

  private successPage(): string {
    var favicon = this.brandIcon ? "<link rel='icon' type='image/png' href='" + this.brandIcon + "'>" : "";
    return "<!DOCTYPE html><html><head><title>BananaBurner</title>" + favicon + "<style>" +
      "*{margin:0;padding:0;box-sizing:border-box}" +
      "body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#111;color:#e0e0e0}" +
      ".card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:40px;text-align:center;max-width:380px;width:100%}.brand{width:72px;height:72px;object-fit:contain;margin:0 auto 20px;display:block}" +
      "h1{font-size:18px;font-weight:600;margin-bottom:8px;color:#fff}" +
      "p{font-size:13px;color:#888;line-height:1.5}" +
      "</style></head><body><div class='card'>" +
      (this.brandIcon ? "<img class='brand' src='" + this.brandIcon + "' alt='BananaBurner'>" : "") +
      "<h1>Connected</h1>" +
      "<p>Authorization successful.<br>You can close this tab.</p>" +
      "</div></body></html>";
  }

  private errorPage(message: string): string {
    var favicon = this.brandIcon ? "<link rel='icon' type='image/png' href='" + this.brandIcon + "'>" : "";
    return "<!DOCTYPE html><html><head><title>BananaBurner</title>" + favicon + "<style>" +
      "*{margin:0;padding:0;box-sizing:border-box}" +
      "body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#111;color:#e0e0e0}" +
      ".card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:48px 40px;text-align:center;max-width:380px;width:100%}" +
      ".brand{width:72px;height:72px;object-fit:contain;margin:0 auto 20px;display:block}" +
      ".icon{width:48px;height:48px;border-radius:50%;background:#3a1a1a;border:2px solid #f44747;display:flex;align-items:center;justify-content:center;margin:0 auto 20px}" +
      ".icon svg{width:24px;height:24px}" +
      "h1{font-size:18px;font-weight:600;margin-bottom:8px;color:#fff}" +
      "p{font-size:13px;color:#888;line-height:1.5}" +
      "</style></head><body><div class='card'>" +
      (this.brandIcon ? "<img class='brand' src='" + this.brandIcon + "' alt='BananaBurner'>" : "<div class='icon'><svg viewBox='0 0 24 24' fill='none' stroke='#f44747' stroke-width='2.5'><path d='M18 6L6 18M6 6l12 12'/></svg></div>") +
      "<h1>Failed</h1>" +
      "<p>" + this.escapeHtml(message) + "</p>" +
      "</div></body></html>";
  }

  private escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#39;");
  }

  private async waitForCallback(expectedState: string, onListening: () => void): Promise<string | null> {
    return new Promise((resolve) => {
      let resolved = false;

      const server = http.createServer((req, res) => {
        const url = new URL(req.url || "/", "http://127.0.0.1:" + REDIRECT_PORT);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (resolved) return;

        if (url.pathname !== "/callback") {
          res.writeHead(404); res.end(); return;
        }

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(this.errorPage("Authorization failed: " + error));
          resolved = true;
          server.close();
          resolve(null);
          return;
        }

        if (!code || state !== expectedState) {
          var detail = !code ? "missing code" : "state mismatch (got " + (state || "null") + ")";
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(this.errorPage("This callback belongs to another authorization attempt. Return to the authorization tab and try again."));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(this.successPage());
        resolved = true;
        server.close();
        resolve(code);
      });

      server.once("error", (err) => {
        if (resolved) return;
        resolved = true;
        server.close();
        resolve(null);
        vscode.window.showErrorMessage("Could not start the OAuth callback listener: " + err.message);
      });
      server.listen(REDIRECT_PORT, "127.0.0.1", onListening);

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          server.close();
          resolve(null);
        }
      }, 5 * 60 * 1000);
    });
  }

  private async exchangeCode(code: string, verifier: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    });

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const err = await res.json().catch(function () { return {}; });
      throw new Error("Token exchange failed: " + ((err as any).error || res.status));
    }

    const data = (await res.json()) as any;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      scope: data.scope,
    };
  }

  async refreshTokens(refreshToken: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    });

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      throw new Error("Refresh failed");
    }

    const data = (await res.json()) as any;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      scope: data.scope,
    };
  }

  async logout(): Promise<void> {
    this.tokenSet = undefined;
    await this.secrets.delete("bb_tokens");
    await this.secrets.delete("bb_apikey");
  }
}
