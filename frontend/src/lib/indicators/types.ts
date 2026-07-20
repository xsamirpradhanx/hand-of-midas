/**
 * Shared types for the Hand of Midas indicator engine.
 *
 * This module defines the data structures used across all technical
 * indicator calculations. All indicators consume {@link OHLCVBar} arrays
 * and produce typed result arrays.
 *
 * @module types
 */

/**
 * Represents a single OHLCV (Open, High, Low, Close, Volume) price bar.
 *
 * This is the fundamental input type for all indicator calculations.
 */
export interface OHLCVBar {
  /** ISO-8601 date string or unix timestamp string */
  time: string;
  /** Opening price for the bar */
  open: number;
  /** Highest price during the bar */
  high: number;
  /** Lowest price during the bar */
  low: number;
  /** Closing price for the bar */
  close: number;
  /** Trading volume during the bar */
  volume: number;
}

/**
 * A single time-stamped indicator value.
 *
 * Used by indicators that produce a single series (SMA, EMA, RSI, VWAP).
 */
export interface IndicatorValue {
  /** ISO-8601 date string or unix timestamp string, matching the source bar */
  time: string;
  /** The computed indicator value */
  value: number;
}

/**
 * A single time-stamped Bollinger Bands value containing all three bands.
 */
export interface BollingerBandValue {
  /** ISO-8601 date string or unix timestamp string, matching the source bar */
  time: string;
  /** Upper band = middle + stdDev × σ */
  upper: number;
  /** Middle band = SMA(period) */
  middle: number;
  /** Lower band = middle − stdDev × σ */
  lower: number;
}

/**
 * A single time-stamped MACD value containing all three components.
 */
export interface MACDValue {
  /** ISO-8601 date string or unix timestamp string, matching the source bar */
  time: string;
  /** MACD line = EMA(fast) − EMA(slow) */
  macd: number;
  /** Signal line = EMA(signalPeriod) of MACD line */
  signal: number;
  /** Histogram = MACD − Signal */
  histogram: number;
}

/** Supported indicator types */
export type IndicatorType = 'SMA' | 'EMA' | 'RSI' | 'MACD' | 'BOLLINGER' | 'VWAP';

/**
 * Configuration for a single indicator instance on a chart.
 *
 * Used by the UI layer to manage which indicators are active and how
 * they are rendered.
 */
export interface IndicatorConfig {
  /** Unique identifier for this indicator instance */
  id: string;
  /** The type of technical indicator */
  type: IndicatorType;
  /** Indicator-specific parameters (e.g. { period: 14 }) */
  params: Record<string, number>;
  /** CSS color string for rendering */
  color: string;
  /** Whether this indicator is currently visible on the chart */
  visible: boolean;
}
