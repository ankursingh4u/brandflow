module.exports = {
  apps: [
    {
      name: "brandflow-src",
      cwd: "/var/www/brandflow/web",
      script: "index.js",
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 3011,
      },
    },
  ],
};
