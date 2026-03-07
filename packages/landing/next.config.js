/** @type {import('next').NextConfig} */
const mintlifyOrigin = "https://differentai.mintlify.app";

const nextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      {
        source: "/introduction",
        destination: "/docs",
        permanent: false,
      },
      {
        source: "/get-started",
        destination: "/docs/quickstart",
        permanent: false,
      },
      {
        source: "/quickstart",
        destination: "/docs/quickstart",
        permanent: false,
      },
      {
        source: "/development",
        destination: "/docs/development",
        permanent: false,
      },
      {
        source: "/veslo",
        destination: "/docs/veslo",
        permanent: false,
      },
      {
        source: "/veslo-code-router",
        destination: "/docs/veslo-code-router",
        permanent: false,
      },
      {
        source: "/cli",
        destination: "/docs/cli",
        permanent: false,
      },
      {
        source: "/create-veslo-instance",
        destination: "/docs/create-veslo-instance",
        permanent: false,
      },
      {
        source: "/tutorials/:path*",
        destination: "/docs/tutorials/:path*",
        permanent: false,
      },
      {
        source: "/api-reference/:path*",
        destination: "/docs/api-reference/:path*",
        permanent: false,
      },
    ];
  },
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
        destination: `${mintlifyOrigin}/introduction`,
      },
      {
        source: "/docs/get-started",
        destination: `${mintlifyOrigin}/quickstart`,
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
