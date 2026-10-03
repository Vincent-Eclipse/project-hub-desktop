import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// electron-vite 5: die Externalisierung von node_modules-Abhaengigkeiten fuer
// Main und Preload (frueher per externalizeDepsPlugin() erledigt) ist jetzt
// im Kern-Build standardmaessig aktiv - der Plugin-Import entfaellt. Eine
// gezielte Anpassung waere ueber build.externalizeDeps moeglich, wird aber
// fuer Meilenstein 1 nicht benoetigt (Standardverhalten passt).
export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts')
        }
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve('src/renderer/index.html')
      }
    }
  }
})
