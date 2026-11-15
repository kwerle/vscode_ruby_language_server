// A minimal stand-in for the `vscode` module, so unit tests run in plain Node.
// test/support/register.ts makes `require('vscode')` return this module.
//
// It covers only what the extension and vscode-languageclient use. When code
// under test needs more of the API, add it here. The fakes record what was
// done to them (items created, messages shown) so tests can assert on it;
// call resetStub() in beforeEach.

type Listener<T> = (event: T) => unknown;

export class Disposable {
  static from(...disposables: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => disposables.forEach(disposable => disposable.dispose()));
  }

  constructor(private readonly callOnDispose: () => unknown) {}

  dispose() {
    this.callOnDispose();
  }
}

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];

  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.push(listener);
    return new Disposable(() => {
      this.listeners = this.listeners.filter(existing => existing !== listener);
    });
  };

  fire(data: T) {
    this.listeners.slice().forEach(listener => listener(data));
  }

  dispose() {
    this.listeners = [];
  }
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export class FakeStatusBarItem {
  text = '';
  tooltip: string | undefined;
  command: string | undefined;
  visible = false;
  disposed = false;

  constructor(readonly alignment?: StatusBarAlignment, readonly priority?: number) {}

  show() { this.visible = true; }
  hide() { this.visible = false; }
  dispose() { this.disposed = true; }
}

export class FakeOutputChannel {
  text = '';

  constructor(readonly name: string) {}

  append(value: string) { this.text += value; }
  appendLine(value: string) { this.text += value + '\n'; }
  show() {}
  dispose() {}
}

export interface ShownMessage {
  level: 'error' | 'warning' | 'information';
  message: string;
  items: unknown[];
}

export const window = {
  statusBarItems: [] as FakeStatusBarItem[],
  outputChannels: [] as FakeOutputChannel[],
  messages: [] as ShownMessage[],

  createStatusBarItem(alignment?: StatusBarAlignment, priority?: number): FakeStatusBarItem {
    const item = new FakeStatusBarItem(alignment, priority);
    window.statusBarItems.push(item);
    return item;
  },
  createOutputChannel(name: string): FakeOutputChannel {
    const channel = new FakeOutputChannel(name);
    window.outputChannels.push(channel);
    return channel;
  },
  showErrorMessage(message: string, ...items: unknown[]): Promise<undefined> {
    window.messages.push({ level: 'error', message, items });
    return Promise.resolve(undefined);
  },
  showWarningMessage(message: string, ...items: unknown[]): Promise<undefined> {
    window.messages.push({ level: 'warning', message, items });
    return Promise.resolve(undefined);
  },
  showInformationMessage(message: string, ...items: unknown[]): Promise<undefined> {
    window.messages.push({ level: 'information', message, items });
    return Promise.resolve(undefined);
  },
};

type CommandHandler = (...args: unknown[]) => unknown;

export const commands = {
  registered: new Map<string, CommandHandler>(),

  registerCommand(id: string, handler: CommandHandler): Disposable {
    commands.registered.set(id, handler);
    return new Disposable(() => commands.registered.delete(id));
  },
  executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
    const handler = commands.registered.get(id);
    return Promise.resolve(handler ? handler(...args) : undefined);
  },
};

export const workspace = {
  workspaceFolders: undefined as { uri: { fsPath: string } }[] | undefined,
  textDocuments: [] as { languageId: string, uri: { scheme: string, fsPath: string } }[],
  // Settings by section, e.g. configuration['ruby-language-server'] = { dockerImage: '…' }.
  configuration: {} as { [section: string]: { [key: string]: unknown } },

  getConfiguration(section: string) {
    return { ...(workspace.configuration[section] || {}) };
  },
};

// vscode-languageclient subclasses these when it loads.
export class CompletionItem {}
export class CodeLens {}
export class DocumentLink {}

export function resetStub() {
  window.statusBarItems = [];
  window.outputChannels = [];
  window.messages = [];
  commands.registered.clear();
  workspace.workspaceFolders = undefined;
  workspace.textDocuments = [];
  workspace.configuration = {};
}
