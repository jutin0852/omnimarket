import { describe, expect, it } from 'vitest'
import { fromJson, toJson, ScalarType, type DescMessage, type JsonValue } from '@bufbuild/protobuf'
import { file_omnimarket_api_v1_automation } from './generated/omnimarket/api/v1/automation_pb'
import { file_omnimarket_api_v1_common } from './generated/omnimarket/api/v1/common_pb'
import { file_omnimarket_api_v1_market } from './generated/omnimarket/api/v1/market_pb'
import { file_omnimarket_api_v1_stream } from './generated/omnimarket/api/v1/stream_pb'
import { file_omnimarket_api_v1_trading } from './generated/omnimarket/api/v1/trading_pb'
import { LineageSchema } from './generated/omnimarket/lineage/v1/lineage_pb'
import { apiFixtureFiles, apiFixturesJson } from '../mocks/fixtures/api'
import {
  checkValues,
  decimalField,
  fixtureSchemaForPath,
  isStringField,
  type Problem,
  validateCandleSeriesJson,
} from './contract-validation'

// The API contract v0 (#75, D91): proto/omnimarket/api/v1, as generated here.
const apiFiles = [
  file_omnimarket_api_v1_common,
  file_omnimarket_api_v1_market,
  file_omnimarket_api_v1_trading,
  file_omnimarket_api_v1_automation,
  file_omnimarket_api_v1_stream,
]
const apiMessages: DescMessage[] = apiFiles.flatMap((file) => file.messages)
const fixtureMessages: DescMessage[] = [...apiMessages, LineageSchema]

// Messages that aren't records, so carry no lineage (D91): requests (they carry a
// client_request_id the server derives their lineage from), the WebSocket envelope around
// records, and parts that only appear inside a record.
const notRecords = new Set([
  'QuoteRequest',
  'TradeRequest',
  'PlaceOrderRequest',
  'UpdateOrderRequest',
  'CancelOrderRequest',
  'ClientMessage',
  'Subscribe',
  'Unsubscribe',
  'ServerMessage',
  'Snapshot',
  'Delta',
  'Heartbeat',
  'StreamError',
  'TokenRef',
  'RouteLeg',
  'Fee',
  'WindowStats',
  'PoolSummary',
  'SafetySummary',
  'Slippage',
  'TradeStepTiming',
  'Balance',
  'OrderLevel',
])

function allMessages(roots: readonly DescMessage[]): DescMessage[] {
  const seen = new Map<string, DescMessage>()
  const visit = (desc: DescMessage) => {
    if (seen.has(desc.typeName)) return
    seen.set(desc.typeName, desc)
    desc.nestedMessages.forEach(visit)
    for (const field of desc.fields) {
      if (field.message) visit(field.message)
    }
  }
  roots.forEach(visit)
  return [...seen.values()]
}

type ResolvedFixture = { path: string; json: JsonValue; schema: DescMessage }

const resolvedFixtures: ResolvedFixture[] = apiFixtureFiles.flatMap(({ path, json }) => {
  const schema = fixtureSchemaForPath(path, fixtureMessages)
  return schema ? [{ path, json, schema }] : []
})
const unmappedFixturePaths = apiFixtureFiles
  .filter(({ path }) => !fixtureSchemaForPath(path, fixtureMessages))
  .map(({ path }) => path)

function candleFixture(path: string): ResolvedFixture {
  const fixture = resolvedFixtures.find((candidate) => candidate.path === path)
  if (!fixture) throw new Error(`missing fixture ${path}`)
  return fixture
}

function clonedFixture(path: string): Record<string, JsonValue> {
  const json = structuredClone(candleFixture(path).json)
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${path} is not a JSON object`)
  return json as Record<string, JsonValue>
}

function firstCandle(fixture: Record<string, JsonValue>, path: string): Record<string, JsonValue> {
  const candles = fixture.candles
  if (!Array.isArray(candles) || candles.length === 0) throw new Error(`${path} has no candles`)
  const candle = candles[0]
  if (candle === null || typeof candle !== 'object' || Array.isArray(candle)) throw new Error(`${path} has an invalid candle`)
  return candle as Record<string, JsonValue>
}

describe('API contract v0', () => {
  it('resolves every recursive fixture to a generated schema', () => {
    expect(unmappedFixturePaths, `Unmapped fixture JSON: ${unmappedFixturePaths.join(', ')}`).toEqual([])
  })

  it('has a fixture for every message, and no fixture without a message', () => {
    const names = fixtureMessages.map((desc) => desc.name).sort()
    expect(Object.keys(apiFixturesJson).sort()).toEqual(names)
  })

  it.each(resolvedFixtures.map(({ path, json, schema }) => [path, json, schema] as const))(
    'the %s fixture is canonical proto3 JSON for its generated schema',
    (_path, json, schema) => {
      // fromJson rejects unknown fields and wrong types; the round trip rejects non-canonical forms.
      expect(toJson(schema, fromJson(schema, json))).toEqual(json)
    },
  )

  it('carries lineage on every record', () => {
    const missing = apiMessages
      .filter((desc) => !notRecords.has(desc.name))
      .filter((desc) => desc.field.lineage?.message?.typeName !== LineageSchema.typeName)
      .map((desc) => desc.name)
    expect(missing).toEqual([])

    for (const desc of apiMessages.filter((d) => !notRecords.has(d.name))) {
      const fixture = fromJson(desc, apiFixturesJson[desc.name]) as unknown as { lineage?: { id: Uint8Array } }
      expect(fixture.lineage?.id.length, `${desc.name} fixture's lineage ID`).toBe(16)
    }
  })

  it('lists only messages that exist as non-records', () => {
    const names = new Set(apiMessages.map((desc) => desc.name))
    expect([...notRecords].filter((name) => !names.has(name))).toEqual([])
  })

  it('sends amounts as decimal strings, never numbers', () => {
    const problems: Problem[] = []
    for (const desc of allMessages(apiMessages)) {
      for (const field of desc.fields) {
        if (field.fieldKind === 'scalar' || field.fieldKind === 'list') {
          if (field.scalar === ScalarType.FLOAT || field.scalar === ScalarType.DOUBLE) {
            problems.push(`${desc.typeName}.${field.name} is a float`)
          }
        }
        if (field.fieldKind !== 'message' && decimalField.test(field.name) && !isStringField(field)) {
          problems.push(`${desc.typeName}.${field.name} isn't a string`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it('writes decimals and hex in the agreed forms in every fixture', () => {
    const problems: Problem[] = []
    for (const { path, json, schema } of resolvedFixtures) checkValues(schema, json, path, problems)
    expect(problems).toEqual([])
  })

  it('validates every candle series fixture', () => {
    const problems = resolvedFixtures
      .filter(({ path }) => path.startsWith('candles/'))
      .flatMap(({ path, json }) => validateCandleSeriesJson(path, json))
    expect(problems).toEqual([])
  })

  it('rejects a numeric decimal mutation', () => {
    const fixture = clonedFixture('candles/15m.json')
    firstCandle(fixture, 'candles/15m.json').openUsd = 0.0115
    const problems = validateCandleSeriesJson('candles/15m.json (numeric decimal mutation)', fixture)
    expect(problems.join('\n')).toMatch(/candles\/15m\.json.*(cannot|invalid|number|string|expected)/i)
  })

  it('rejects a candle whose high is below its close', () => {
    const fixture = clonedFixture('candles/15m.json')
    firstCandle(fixture, 'candles/15m.json').highUsd = '0.01160'
    const problems = validateCandleSeriesJson('candles/15m.json (OHLC mutation)', fixture)
    expect(problems).toEqual(expect.arrayContaining([expect.stringContaining('highUsd must bound')]))
  })

  it('rejects a candle with a misaligned timestamp', () => {
    const fixture = clonedFixture('candles/15m.json')
    firstCandle(fixture, 'candles/15m.json').openTimeMs = '1789992900001'
    const problems = validateCandleSeriesJson('candles/15m.json (timestamp mutation)', fixture)
    expect(problems).toEqual(expect.arrayContaining([expect.stringContaining('not aligned to its interval')]))
  })

  it('does not provide a schema for an unmapped fixture path', () => {
    expect(fixtureSchemaForPath('future/new-fixture.json', fixtureMessages)).toBeUndefined()
  })
})
