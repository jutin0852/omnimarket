import Decimal from 'decimal.js'
import { fromJson, ScalarType, type DescField, type DescMessage, type JsonValue } from '@bufbuild/protobuf'
import {
  CandleInterval,
  CandleSeriesSchema,
  type CandleSeries,
} from './generated/omnimarket/api/v1/market_pb'

// Fields holding amounts, prices, USD values or percentages: decimal strings on the wire.
export const decimalField = /(^|_)(usd|pct|amount|price|supply|native|bought|returned|spent|quote)$|^amount_|_amount_|^pct_/
export const decimalValue = /^-?(0|[1-9]\d*)(\.\d+)?$/

// Fields holding addresses or hashes: lowercase 0x hex.
export const hexField = /^(address|pool|token|token_in|token_out|spend_token|sender|recipient|wallet_address|tx_hash|block_hash|head_block_hash|intent_hash|firing_id|last_firing_id)$/
export const hexValue = /^0x[0-9a-f]+$/

export type Problem = string

/** Resolves a fixture path to the generated schema that owns its wire contract. */
export function fixtureSchemaForPath(path: string, messages: readonly DescMessage[]): DescMessage | undefined {
  if (path.startsWith('v1/') && path.endsWith('.json') && !path.slice('v1/'.length).includes('/')) {
    const name = path.slice('v1/'.length, -'.json'.length)
    return messages.find((message) => message.name === name)
  }
  if (path.startsWith('candles/') && path.endsWith('.json') && !path.slice('candles/'.length).includes('/')) {
    return CandleSeriesSchema
  }
  return undefined
}

/** Walks a fixture alongside its schema, checking each decimal and hex string. */
export function checkValues(desc: DescMessage, json: JsonValue, path: string, problems: Problem[]) {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return
  for (const field of desc.fields) {
    const value = json[field.jsonName]
    if (value === undefined) continue
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) {
      const at = `${path}.${field.jsonName}`
      if (field.message) {
        checkValues(field.message, item, at, problems)
      } else if (typeof item === 'string' && decimalField.test(field.name) && !decimalValue.test(item)) {
        problems.push(`${at} = "${item}" isn't a decimal string`)
      } else if (typeof item === 'string' && hexField.test(field.name) && !hexValue.test(item)) {
        problems.push(`${at} = "${item}" isn't lowercase 0x hex`)
      }
    }
  }
}

function intervalMilliseconds(interval: CandleInterval): number | undefined {
  const name = CandleInterval[interval]
  const match = name?.match(/^CANDLE_INTERVAL_(\d+)(S|M|H|D)$/)
  if (!match) return undefined
  const unitMilliseconds: Record<string, number> = { S: 1_000, M: 60_000, H: 3_600_000, D: 86_400_000 }
  return Number(match[1]) * unitMilliseconds[match[2]]
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index])
}

function addCandleLineageProblems(series: CandleSeries, path: string, problems: Problem[]) {
  const seriesLineage = series.lineage
  if (!seriesLineage) {
    problems.push(`${path}: candle series is missing lineage`)
    return
  }
  if (seriesLineage.id.length !== 16) problems.push(`${path}: candle series lineage.id must be 16 bytes`)
  for (const [index, cause] of seriesLineage.causedBy.entries()) {
    if (cause.length !== 16) problems.push(`${path}.lineage.causedBy[${index}] must be 16 bytes`)
  }
  const causedBy = seriesLineage.causedBy
  for (const [index, candle] of series.candles.entries()) {
    const candleId = candle.lineage?.id
    if (!candleId) {
      problems.push(`${path}.candles[${index}]: candle is missing lineage.id`)
      continue
    }
    if (candleId.length !== 16) problems.push(`${path}.candles[${index}].lineage.id must be 16 bytes`)
    if (!causedBy.some((cause) => sameBytes(cause, candleId))) {
      problems.push(`${path}: lineage.causedBy is missing candles[${index}] lineage.id`)
    }
  }
}

/** Checks semantic invariants that only apply to CandleSeries fixtures. */
export function validateCandleSeries(series: CandleSeries, path: string): Problem[] {
  const problems: Problem[] = []
  const intervalMs = intervalMilliseconds(series.interval)
  if (intervalMs === undefined) {
    problems.push(`${path}: interval ${CandleInterval[series.interval] ?? series.interval} has no duration`)
    return problems
  }
  if (series.candles.length === 0) {
    problems.push(`${path}: candle series must contain at least one candle`)
    return problems
  }

  addCandleLineageProblems(series, path, problems)
  for (const [index, candle] of series.candles.entries()) {
    const candlePath = `${path}.candles[${index}]`
    const open = new Decimal(candle.openUsd)
    const high = new Decimal(candle.highUsd)
    const low = new Decimal(candle.lowUsd)
    const close = new Decimal(candle.closeUsd)
    if (high.lt(open) || high.lt(close)) problems.push(`${candlePath}: highUsd must bound openUsd and closeUsd`)
    if (low.gt(open) || low.gt(close)) problems.push(`${candlePath}: lowUsd must bound openUsd and closeUsd`)
    if (candle.openTimeMs % BigInt(intervalMs) !== 0n) {
      problems.push(`${candlePath}: openTimeMs ${candle.openTimeMs} is not aligned to its interval`)
    }
    if (index > 0) {
      const previous = series.candles[index - 1]
      if (candle.openTimeMs - previous.openTimeMs !== BigInt(intervalMs)) {
        problems.push(`${candlePath}: openTimeMs is not spaced by the interval`)
      }
    }
    if (index < series.candles.length - 1 && !candle.closed) {
      problems.push(`${candlePath}: only the final candle may be open`)
    }
    if (index === series.candles.length - 1 && candle.closed) {
      problems.push(`${candlePath}: final candle must be open`)
    }
  }
  return problems
}

/** Parses a candle fixture and returns descriptive parse/semantic failures. */
export function validateCandleSeriesJson(path: string, json: JsonValue): Problem[] {
  try {
    const series = fromJson(CandleSeriesSchema, json)
    return validateCandleSeries(series, path)
  } catch (error) {
    return [`${path}: ${error instanceof Error ? error.message : String(error)}`]
  }
}

/** Returns whether a field is a scalar/list string in the generated contract. */
export function isStringField(field: DescField): boolean {
  return (field.fieldKind === 'scalar' || field.fieldKind === 'list') && field.scalar === ScalarType.STRING
}
