'use strict';

// The extension follows the server image's `latest` tag, so it can meet any
// server version: an old local image when offline, or one with known bugs.
// The server reports its version in the initialize result (`serverInfo`,
// ruby_language_server#168); this decides what to say about it.

// The oldest server this extension works properly with.  0.9.8 fixed message
// framing for non-ASCII text (ruby_language_server#167).  Raise it when the
// extension starts depending on newer server behavior.
export const MIN_SERVER_VERSION = '0.9.8';

export interface ServerInfo {
  name: string;
  version?: string;
}

export interface VersionCheck {
  // For the output channel, always.
  log: string;
  // For a warning popup, only when the server is known to be too old.
  warning?: string;
}

// Compares dotted numeric versions ("0.9.10" > "0.9.8").  Missing or
// non-numeric parts count as 0, and anything after a "-" is ignored.
export function compareVersions(a: string, b: string): number {
  const parts = (version: string) => version.split('-')[0].split('.').map(part => parseInt(part, 10) || 0);
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }
  return 0;
}

export function checkServerVersion(info: ServerInfo | undefined, image: string, minimum = MIN_SERVER_VERSION): VersionCheck {
  // Servers before ruby_language_server#168 don't report a version. Only log
  // that: until a reporting server is `latest`, nearly everyone would see a warning.
  if (!info) {
    return { log: "Server didn't report its name or version." };
  }
  if (!info.version) {
    return { log: `Server: ${info.name} (no version reported)` };
  }
  const log = `Server: ${info.name} ${info.version}`;
  if (compareVersions(info.version, minimum) < 0) {
    return {
      log: `${log} (older than ${minimum}, which this extension needs)`,
      warning: `The Ruby language server image is version ${info.version}, but this extension needs ${minimum} or later. ` +
        `Run "docker pull ${image}", then "Ruby Language Server: Restart".`,
    };
  }
  return { log };
}
