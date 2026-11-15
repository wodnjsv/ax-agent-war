// 원본에서 도출한 자료를 problem1/data/derived/ 에 파이프 구분 CSV로 쓴다.
// 사용: node problem1/src/export-data.mjs   (원본은 읽기만 한다)
// 실행 중 모듈은 원본에서 같은 함수로 다시 도출한다. 테스트가 파일과 도출 결과가 같은지 확인한다.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { derivePlanSkuMap, deriveBaselineDemand, toPipeCsv, EFFECTIVE_FROM } from './demand.mjs';

export const DERIVED = {
  planSkuMap: {
    file: 'derived/plan_sku_map.csv',
    columns: ['record_id', 'plan_id', 'campaign_id', 'product_line', 'sku_id',
      'source_ref', 'effective_at', 'source_type', 'is_synthetic', 'generation_reason'],
  },
  baselineDemand: {
    file: 'derived/baseline_demand.csv',
    columns: ['record_id', 'sku_id', 'baseline_weekly_qty', 'baseline_demand_version', 'method', 'window_start', 'window_end',
      'source_ref', 'effective_at', 'source_type', 'is_synthetic', 'generation_reason'],
  },
};

export function derivedCsvTexts(raw) {
  const map = derivePlanSkuMap(raw).map((r, i) => ({
    ...r, record_id: `P1-MAP-${String(i + 1).padStart(3, '0')}`, effective_at: EFFECTIVE_FROM, is_synthetic: 'false',
    generation_reason: '기안에 SKU가 없어 캠페인 제품라인 = SKU 분류로 전개(명세 3.2)',
  }));
  const base = deriveBaselineDemand(raw).map((r, i) => ({
    ...r, record_id: `P1-BD-${String(i + 1).padStart(3, '0')}`, baseline_weekly_qty: r.baseline_weekly_qty.toFixed(2),
    is_synthetic: 'false', generation_reason: '캠페인 추가분 EA의 기준. 최근 4주 평균(calculation_definitions 1.3)',
  }));
  return {
    [DERIVED.planSkuMap.file]: toPipeCsv(DERIVED.planSkuMap.columns, map),
    [DERIVED.baselineDemand.file]: toPipeCsv(DERIVED.baselineDemand.columns, base),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { createRawLoader } = await import('../../app/core/csv.mjs');
  const { RAW_DIR } = await import('../../app/core/paths.mjs');
  const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
  for (const [file, text] of Object.entries(derivedCsvTexts(createRawLoader(RAW_DIR)))) {
    const full = path.join(dataDir, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
    console.log(`[p1] ${path.relative(process.cwd(), full)} ${text.trim().split('\n').length - 1}행`);
  }
}
