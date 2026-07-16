import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow localtunnel and ngrok domains for testing
  allowedDevOrigins: [
    "loca.lt",
    "*.loca.lt",
    "ngrok-free.app",
    "*.ngrok-free.app",
    "ngrok.app",
    "*.ngrok.app"
  ]
};

export default nextConfig;
