// 파이프(|) 구분 CSV. 값은 모두 문자열로 둔다. 'NONE'은 0으로 바꾸지 않는다.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export function parsePipeCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split('|');
  return lines.slice(1).map((line, i) => {
    const cells = line.split('|');
    if (cells.length !== header.length) {
      throw new Error(`열 개수가 헤더와 다릅니다: ${i + 2}행 (${cells.length} != ${header.length})`);
    }
    return Object.fromEntries(header.map((h, j) => [h, cells[j]]));
  });
}

// 숫자 변환. 'NONE'과 빈 값은 null(0이 아님).
export function toNum(value) {
  if (value === undefined || value === null || value === '' || value === 'NONE') return null;
  const n = Number(value);
  if (Number.isNaN(n)) throw new Error(`숫자가 아닙니다: ${value}`);
  return n;
}

function insideDir(baseDir, relPath) {
  const full = path.resolve(baseDir, relPath);
  if (!full.startsWith(path.resolve(baseDir) + path.sep)) {
    throw new Error(`허용된 폴더 밖의 경로입니다: ${relPath}`);
  }
  return full;
}

// 원본 데이터 로더(읽기 전용). relPath 예: '02_masil/marketing/mkt_budget_plan_ms.csv'
export function createRawLoader(rawDir) {
  const cache = new Map();
  return {
    dir: rawDir,
    load(relPath) {
      if (!cache.has(relPath)) {
        cache.set(relPath, Object.freeze(parsePipeCsv(readFileSync(insideDir(rawDir, relPath), 'utf8')).map(Object.freeze)));
      }
      return cache.get(relPath);
    },
    text(relPath) {
      return readFileSync(insideDir(rawDir, relPath), 'utf8');
    },
  };
}

// 문제별 자료 로더. problemN/data/<file>
export function createProblemDataLoader(problemDirFn) {
  return {
    load(n, file, { optional = false } = {}) {
      const dataDir = path.join(problemDirFn(n), 'data');
      const full = insideDir(dataDir, file);
      if (!existsSync(full)) {
        if (optional) return [];
        throw new Error(`자료 파일이 없습니다: problem${n}/data/${file}`);
      }
      return parsePipeCsv(readFileSync(full, 'utf8'));
    },
  };
}
