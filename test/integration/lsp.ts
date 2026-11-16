// A minimal LSP client over a server's streams, for integration tests.
// Framing is byte-accurate (Content-Length counts bytes), so a server that
// miscounts shows up as a parse failure instead of being papered over.
import { pathToFileURL } from 'url';
import { StreamInfo } from 'vscode-languageclient';

interface Message {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code: number, message: string };
}

export class LspConnection {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, (message: Message) => void>();
  // Bodies that weren't valid JSON: a framing bug in the server.
  readonly unparseable: string[] = [];

  constructor(private readonly stream: StreamInfo) {
    stream.reader.on('data', (chunk: Buffer) => this.receive(chunk));
  }

  request(method: string, params: unknown, timeoutMs = 30000): Promise<Message> {
    const id = this.nextId++;
    this.send({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`No reply to ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, message => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }

  notify(method: string, params: unknown) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  // initialize + initialized, the way a client starts a session.
  async initialize(root: string): Promise<Message> {
    const reply = await this.request('initialize', { processId: process.pid, rootPath: root, rootUri: uriOf(root), capabilities: {} });
    this.notify('initialized', {});
    return reply;
  }

  open(file: string, text: string) {
    this.notify('textDocument/didOpen', { textDocument: { uri: uriOf(file), languageId: 'ruby', version: 1, text } });
  }

  private send(message: object) {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.stream.writer.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.stream.writer.write(body);
  }

  private receive(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const header = this.buffer.slice(0, headerEnd).toString('ascii');
      const match = /Content-Length: (\d+)/i.exec(header);
      if (!match) {
        this.unparseable.push(header);
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      if (this.buffer.length < headerEnd + 4 + length) {
        return;
      }
      const body = this.buffer.slice(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
      this.buffer = this.buffer.slice(headerEnd + 4 + length);
      let message: Message;
      try {
        message = JSON.parse(body);
      } catch (error) {
        this.unparseable.push(body);
        continue;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const resolve = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        resolve(message);
      }
    }
  }
}

export function uriOf(file: string): string {
  return pathToFileURL(file).href;
}
