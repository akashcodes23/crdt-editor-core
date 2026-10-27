import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Monaco editor requires these webpack tweaks
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Monaco ships worker files; suppress the warnings
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
      }
    }
    return config
  },

  // Transpile monaco-editor for Next.js
  transpilePackages: ['monaco-editor'],
}

export default nextConfig
