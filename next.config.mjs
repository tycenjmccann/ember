/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  experimental: {
    outputFileTracingIncludes: {
      "/api/**": ["./node_modules/@aws-sdk/**"],
    },
    serverComponentsExternalPackages: [
      "@aws-sdk/client-dynamodb",
      "@aws-sdk/lib-dynamodb",
      "@aws-sdk/client-s3",
      "@aws-sdk/client-bedrock-agentcore",
      "@smithy/node-http-handler",
    ],
  },
};

export default nextConfig;
