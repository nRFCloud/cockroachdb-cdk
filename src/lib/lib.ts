import { promisify } from 'util';
import { join } from 'path';
import { createHash } from 'crypto';

export const timeoutAsync = promisify((ms: number, cb: (err: any) => void) => setTimeout(cb, ms))

export async function retryWithBackoff<T>(func: (...args: any[]) => T, tries = 10, constantWait?: number): Promise<T> {
  let lastErr: Error = new Error();
  for (let i=0; i < tries; i++) {
    try {
      const result = await func();
      return result;
    } catch (err) {
      lastErr = err;
      const timeout = constantWait ? constantWait : (2**i) * 100
      console.error(`Error occurred, retrying in ${timeout}ms`)
      console.error(err);
      await timeoutAsync(timeout);
    }
  }
  throw lastErr;
}

export const CONTAINER_PATH = join(__dirname, '..', '..', 'containers')

export const HANDLER_PATH = join(__dirname, '..', 'handlers')

export function getContainerPath(name: string) {
  return join(CONTAINER_PATH, name)
}

export function getHandlerPath(name: string) {
  return join(HANDLER_PATH, name)
}

export function hashString(string: string, chars = 6) {
  return createHash('sha1').update(string).digest().toString('hex').substr(0, chars)
}
