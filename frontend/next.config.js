/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Everything this app does is client-side: read the chain, read the proxy, verify a signature in
  // the browser. There is no server component that needs secrets and no API route, which is
  // deliberate — a verification page that asked you to trust its backend would defeat its own
  // purpose. These two values are public by nature.
  env: {
    NEXT_PUBLIC_FIDENSUR_CONTRACT: process.env.NEXT_PUBLIC_FIDENSUR_CONTRACT ?? "",
    NEXT_PUBLIC_EXT_PROXY_URL: process.env.NEXT_PUBLIC_EXT_PROXY_URL ?? "",
  },
};

module.exports = nextConfig;
