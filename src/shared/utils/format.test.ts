import { describe, it, expect } from 'vitest'
import {
  formatInteger, formatPercent, formatHours, formatDecimal, formatMoney,
} from './format'

describe('format', () => {
  it('formats integers with zh-CN locale', () => {
    expect(formatInteger(1234567)).toBe('1,234,567')
    expect(formatInteger(null)).toBe('0')
    expect(formatInteger(undefined)).toBe('0')
  })

  it('truncates fractional input to integer (no decimal noise)', () => {
    expect(formatInteger(17036.411123)).toBe('17,036')
    expect(formatInteger(131.0)).toBe('131')
    expect(formatInteger(0.4)).toBe('0')
  })

  it('formats percent with default 2 digits', () => {
    expect(formatPercent(0.1234)).toBe('12.34%')
    expect(formatPercent(0.1234, 1)).toBe('12.3%')
    expect(formatPercent(null)).toBe('0.00%')
  })

  it('formats hours', () => {
    expect(formatHours(2.45)).toBe('2.5h')
    expect(formatHours(0)).toBe('0.0h')
    expect(formatHours(null)).toBe('0.0h')
  })

  it('formats decimal', () => {
    expect(formatDecimal(2.456)).toBe('2.5')
    expect(formatDecimal(2.456, 2)).toBe('2.46')
    expect(formatDecimal(null)).toBe('0.0')
  })

  it('formats money with $ prefix and no decimal noise', () => {
    expect(formatMoney(1234)).toBe('$1,234')
    expect(formatMoney(17036.411123)).toBe('$17,036')
    expect(formatMoney(null)).toBe('--')
  })
})
