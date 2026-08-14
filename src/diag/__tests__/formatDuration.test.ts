import { formatDurationMs, spanDurationMs } from '../formatDuration';

describe('formatDurationMs', () => {
  it('renders sub-second durations as whole milliseconds', () => {
    expect(formatDurationMs(0)).toBe('0ms');
    expect(formatDurationMs(310)).toBe('310ms');
    expect(formatDurationMs(999)).toBe('999ms');
  });

  it('rounds fractional milliseconds', () => {
    expect(formatDurationMs(310.6)).toBe('311ms');
  });

  it('switches to seconds with two decimals at 1000ms', () => {
    expect(formatDurationMs(1000)).toBe('1.00s');
    expect(formatDurationMs(1840)).toBe('1.84s');
    expect(formatDurationMs(60500)).toBe('60.50s');
  });
});

describe('spanDurationMs', () => {
  it('uses endMs when the span has ended', () => {
    expect(spanDurationMs(100, 400, 999)).toBe(300);
  });

  it('falls back to "now" for a still-running span', () => {
    expect(spanDurationMs(100, null, 350)).toBe(250);
  });
});
