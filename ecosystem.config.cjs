module.exports = {
  apps: [
    {
      name: "instantvote",
      cwd: __dirname,
      // Launch Node directly so server.mjs runs as the entry point under PM2.
      script: process.execPath,
      args: "server.mjs",
      interpreter: "none",
      time: true,
      env: {
        NODE_ENV: "production",
        PORT: 3002,
      },
    },
  ],
};
