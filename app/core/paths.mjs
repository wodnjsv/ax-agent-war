import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RAW_DIR = path.join(ROOT_DIR, '01_참가자_배포용', '04_원본데이터');
export const DEFAULT_DB_PATH = path.join(ROOT_DIR, 'var', 'w01.sqlite');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'app', 'public');

export const problemDir = (rootDir, n) => path.join(rootDir, `problem${n}`);
