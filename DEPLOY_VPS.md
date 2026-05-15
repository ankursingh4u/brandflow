## Ubuntu VPS Deploy

### 1. Install runtime
```bash
sudo apt update
sudo apt install -y nginx git curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

### 2. Clone repo
```bash
cd /var/www
git clone https://github.com/ankur4work/-mx-brand-logo.git brandflow
cd /var/www/brandflow
```

### 3. Install packages and build frontend
```bash
npm install
cd web
npm install
cd frontend
npm install
npm run build
cd ..
```

### 4. Add production env
```bash
cp /var/www/brandflow/web/.env.example /var/www/brandflow/web/.env
nano /var/www/brandflow/web/.env
```

Required production values:
- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SCOPES`
- `HOST`
- `SHOPIFY_APP_HANDLE`
- `SHOPIFY_REQUIRE_ACTIVE_PLAN=true`
- `BILLING_MODE=managed`
- `SESSION_STORAGE=mongodb`
- `MONGODB_URI`
- `MONGODB_DB_NAME`
- `PORT=3011`

### 5. Start with pm2
```bash
cd /var/www/brandflow
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

### 6. Configure nginx
```bash
sudo cp /var/www/brandflow/deploy/nginx-brandflow.conf /etc/nginx/sites-available/brandflow
sudo nano /etc/nginx/sites-available/brandflow
```

Replace `app.example.com` with your real subdomain, then enable:
```bash
sudo ln -s /etc/nginx/sites-available/brandflow /etc/nginx/sites-enabled/brandflow
sudo nginx -t
sudo systemctl reload nginx
```

### 7. Add SSL
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d app.example.com
```

### 8. Update Shopify app settings
In Partner Dashboard set:
- App URL: `https://app.example.com`
- Allowed redirection URL: `https://app.example.com/api/auth/callback`

### 9. Future updates
```bash
cd /var/www/brandflow
git pull
cd web/frontend
npm run build
cd ..
pm2 restart brandflow-src
```
