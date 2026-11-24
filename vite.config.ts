import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';

function discoverCityTileIds(): string[] {
  const dir = join(process.cwd(), 'public/assets/tiles/cities');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.webp'))
    .map((name) => name.slice(0, -'.webp'.length))
    .sort();
}

export default defineConfig({
  base: './',
  define: {
    __CITY_TILE_IDS__: JSON.stringify(discoverCityTileIds()),
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
} as never);
