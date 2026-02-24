/** @type {import('next').NextConfig} */
const mintlifyOrigin = "https://differentai.mintlify.app";

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/_mintlify/:path*",
        destination: `${mintlifyOrigin}/_mintlify/:path*`,
      },
      {
        source: "/api/request",
        destination: `${mintlifyOrigin}/_mintlify/api/request`,
      },
      {
        source: "/docs",
        destination: `${mintlifyOrigin}/`,
      },
      {
        source: "/docs/get-started",
        destination: `${mintlifyOrigin}/quickstart`,
      },
      {
        source: "/docs/llms.txt",
        destination: `${mintlifyOrigin}/llms.txt`,
      },
      {
        source: "/docs/llms-full.txt",
        destination: `${mintlifyOrigin}/llms-full.txt`,
      },
      {
        source: "/docs/sitemap.xml",
        destination: `${mintlifyOrigin}/sitemap.xml`,
      },
      {
        source: "/docs/robots.txt",
        destination: `${mintlifyOrigin}/robots.txt`,
      },
      {
        source: "/docs/mcp",
        destination: `${mintlifyOrigin}/mcp`,
      },
      {
        source: "/docs/:path*",
        destination: `${mintlifyOrigin}/:path*`,
      },
      {
        source: "/mintlify-assets/:path+",
        destination: `${mintlifyOrigin}/mintlify-assets/:path+`,
      },
    ];
  },
};

module.exports = nextConfig;
