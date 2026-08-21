import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EVALUATION_MODEL,
  DEFAULT_EVALUATION_REPETITIONS,
  DEFAULT_EVALUATION_TIMEOUT_MS,
  parseEvaluationModel,
  parseEvaluationRepetitions,
  parseEvaluationTimeoutMs,
  parseReplayMetadata,
} from './options.js'

describe('parseEvaluationModel', () => {
  it('默认标记 M3，并保留显式参考组模型', () => {
    expect(parseEvaluationModel(undefined)).toBe(DEFAULT_EVALUATION_MODEL)
    expect(parseEvaluationModel('  mlx-community/Qwen3.8-27B-4bit@revision  '))
      .toBe('mlx-community/Qwen3.8-27B-4bit@revision')
  })
})

describe('parseEvaluationTimeoutMs', () => {
  it('使用五分钟默认值', () => {
    expect(parseEvaluationTimeoutMs(undefined)).toBe(DEFAULT_EVALUATION_TIMEOUT_MS)
  })

  it.each(['0', '999', '1.5', '3600001', 'nope'])('拒绝无效值 %s', (value) => {
    expect(() => parseEvaluationTimeoutMs(value)).toThrow('MYTHOS_EVAL_TIMEOUT_MS')
  })
})

describe('parseReplayMetadata', () => {
  it('校验并返回成对回放元数据', () => {
    expect(parseReplayMetadata(undefined, undefined)).toBeUndefined()
    expect(parseReplayMetadata('2', '3')).toEqual({ iteration: 2, total: 3 })
  })

  it.each([
    ['1', undefined],
    ['0', '3'],
    ['4', '3'],
    ['1', '21'],
  ])('拒绝无效组合 %s/%s', (iteration, total) => {
    expect(() => parseReplayMetadata(iteration, total)).toThrow('回放')
  })
})

describe('parseEvaluationRepetitions', () => {
  it('默认重复三次并接受安全范围', () => {
    expect(parseEvaluationRepetitions(undefined)).toBe(DEFAULT_EVALUATION_REPETITIONS)
    expect(parseEvaluationRepetitions('20')).toBe(20)
  })

  it.each(['0', '1.5', '21', 'nope'])('拒绝无效值 %s', (value) => {
    expect(() => parseEvaluationRepetitions(value)).toThrow('MYTHOS_EVAL_REPETITIONS')
  })
})
