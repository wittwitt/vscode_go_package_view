const prefix = '[GoPkgView]';

export function log(...args: any[]) {
  console.log(prefix, ...args);
}

export function logError(...args: any[]) {
  console.error(prefix, ...args);
}
