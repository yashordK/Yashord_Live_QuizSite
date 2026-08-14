/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Question images are optional and may be hosted anywhere; we render them with
  // a plain <img> rather than next/image so no remote-host allowlist is needed.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
