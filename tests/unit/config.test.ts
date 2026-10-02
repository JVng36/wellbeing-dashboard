import { describe, expect, it } from 'vitest';
import { defaultDataDir, validateExternalDataDir, validateRuntimeConfig } from '../../src/server/config.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('runtime safety configuration', () => {
  it('uses an external default and rejects source-relative data', () => {
    expect(defaultDataDir()).not.toContain(process.cwd());
    expect(() => validateExternalDataDir(join(process.cwd(), '.wellbeing-data'))).toThrow(/outside the source tree/);
    expect(validateExternalDataDir(join(tmpdir(), 'wellbeing-config-test'))).toContain('wellbeing-config-test');
  });
  it('requires valid exact HTTPS origin for non-loopback configuration', () => {
    expect(() => validateRuntimeConfig('0.0.0.0', 8787)).toThrow(/secure mode/);
    expect(() => validateRuntimeConfig('0.0.0.0', 8787, 'https://example.test', false)).toThrow(/secure mode/);
    expect(() => validateRuntimeConfig('0.0.0.0', 8787, 'http://example.test', true)).toThrow(/HTTPS/);
    expect(() => validateRuntimeConfig('0.0.0.0', 8787, 'https://example.test/path', true)).toThrow(/exact/);
    expect(() => validateRuntimeConfig('0.0.0.0', 8787, 'https://example.test', true)).not.toThrow();
    expect(() => validateRuntimeConfig('127.0.0.1', 0)).toThrow(/1 to 65535/);
  });
});
