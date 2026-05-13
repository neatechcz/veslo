declare module '@tauri-apps/api/dpi' {
  export class LogicalPosition {
    constructor(x: number, y: number);
  }

  export class LogicalSize {
    constructor(width: number, height: number);
  }
}

declare module '@tauri-apps/api/window' {
  export function getCurrentWindow(): {
    show(): Promise<void>;
    unminimize(): Promise<void>;
    setSize(size: unknown): Promise<void>;
    setPosition(position: unknown): Promise<void>;
    setFocus(): Promise<void>;
  };
}
