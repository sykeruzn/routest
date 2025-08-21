/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next 15: use this (not experimental.serverComponentsExternalPackages)
  serverExternalPackages: ['pg'],
};

module.exports = nextConfig;