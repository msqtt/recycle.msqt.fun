import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const sdkSrc = (pkg: string) =>
  fileURLToPath(new URL(`../wtop-sdk/packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    headers: {
      // dev 专用：Vite 注入内联 react-refresh 脚本需要 unsafe-inline；ajv 运行时编译 schema 需要 unsafe-eval
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; frame-src https: http://localhost:* http://127.0.0.1:*; connect-src https: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'",
      'Referrer-Policy': 'no-referrer',
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
    // 测试直接跑 SDK 源码；应用构建走 vendor/wtop 产物
    alias: {
      '@wtop/types': sdkSrc('types'),
      '@wtop/core': sdkSrc('core'),
      '@wtop/host': sdkSrc('host'),
    },
  },
});