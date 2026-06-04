export default {
  apps: [
    {
      name: "wa-web-agent",
      script: "./server.js",
      cwd: process.cwd(),
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production"
      }
    }
  ]
};
