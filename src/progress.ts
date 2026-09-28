import * as vscode from "vscode";

export class RemoteActivity implements vscode.Disposable {
  private active = 0;
  private status: vscode.StatusBarItem;
  private label = "Working";

  constructor() {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 110);
    this.status.tooltip = "BananaBurner remote operation in progress";
  }

  start(label: string): void {
    this.active++;
    this.label = label;
    this.status.text = "$(sync~spin) " + label + "…";
    this.status.show();
  }

  end(): void {
    this.active = Math.max(0, this.active - 1);
    if (this.active === 0) this.status.hide();
  }

  async run<T>(label: string, operation: () => Promise<T>): Promise<T> {
    this.start(label);
    try {
      return await operation();
    } finally {
      this.end();
    }
  }

  dispose(): void {
    this.status.dispose();
  }
}
