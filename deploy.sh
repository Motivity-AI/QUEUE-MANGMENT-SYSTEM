#!/usr/bin/env bash
# ============================================================
# deploy.sh — نشر كامل تلقائي لنظام ترتيب الصفوف (SaaS)
# الاستخدام:
#   sudo ./deploy.sh --domain queue.example.com --email you@example.com
#   sudo ./deploy.sh --local   (اختبار محلي بدون SSL)
# ============================================================
set -euo pipefail

# ---------- ألوان ----------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
log()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
err()   { echo -e "${RED}[✗]${NC} $*" >&2; }
info()  { echo -e "${BLUE}[i]${NC} $*"; }
title() { echo -e "\n${BOLD}${BLUE}━━━ $* ━━━${NC}\n"; }

# ---------- المسار والصلاحيات ----------
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

if [[ $EUID -eq 0 ]]; then SUDO=""; else SUDO="sudo"; fi
if [[ -z "$SUDO" ]] || $SUDO -n true 2>/dev/null; then
  : # صلاحيات متاحة
else
  err "هذا السكريبت يحتاج صلاحيات root. شغّله بـ sudo أو كـ root."
  exit 1
fi

# ---------- معالجة الخيارات ----------
DOMAIN=""
EMAIL=""
LOCAL_MODE=0
SKIP_DOCKER_INSTALL=0

usage() {
  cat <<EOF
الاستخدام:
  $0 --domain <domain> --email <email>    نشر إنتاجي مع SSL
  $0 --local                              اختبار محلي بدون SSL
  $0 --help                               عرض المساعدة

خيارات إضافية:
  --skip-docker-install   لا تحاول تثبيت Docker (يفترض أنه مثبّت)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2;;
    --email)  EMAIL="$2";  shift 2;;
    --local)  LOCAL_MODE=1; shift;;
    --skip-docker-install) SKIP_DOCKER_INSTALL=1; shift;;
    --help|-h) usage; exit 0;;
    *) err "خيار غير معروف: $1"; usage; exit 1;;
  esac
done

if [[ $LOCAL_MODE -eq 0 ]] && { [[ -z "$DOMAIN" ]] || [[ -z "$EMAIL" ]]; }; then
  err "في الوضع الإنتاجي، --domain و --email مطلوبان."
  usage; exit 1
fi

# ---------- فحص المتطلبات الأساسية ----------
title "1/9 فحص المتطلبات"

# نظام التشغيل
if [[ ! -f /etc/os-release ]]; then
  err "نظام تشغيل غير مدعوم (لا يوجد /etc/os-release)"; exit 1
fi
. /etc/os-release
OS_ID="${ID:-unknown}"
OS_LIKE="${ID_LIKE:-$OS_ID}"
log "النظام: $PRETTY_NAME"

# الحزم الأساسية
for pkg in curl openssl sed grep; do
  command -v "$pkg" >/dev/null 2>&1 || { err "الحزمة $pkg غير مثبتة"; exit 1; }
done
log "الحزم الأساسية متوفرة"

# التحقق من وجود ملفات المشروع
for f in server.js package.json Dockerfile docker-compose.yml; do
  if [[ ! -f "$f" ]]; then err "ملف مفقود: $f — شغّل السكريبت من مجلد المشروع"; exit 1; fi
done
log "ملفات المشروع موجودة"

# ---------- تثبيت Docker ----------
title "2/9 تثبيت Docker"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  log "Docker وDocker Compose مثبتان مسبقاً"
elif [[ $SKIP_DOCKER_INSTALL -eq 1 ]]; then
  err "Docker غير مثبت لكن تم استخدام --skip-docker-install"; exit 1
else
  info "تثبيت Docker..."
  if [[ "$OS_LIKE" == *"debian"* ]] || [[ "$OS_LIKE" == *"ubuntu"* ]]; then
    $SUDO apt-get update -y
    $SUDO apt-get install -y ca-certificates curl gnupg lsb-release
    $SUDO install -m 0755 -d /etc/apt/keyrings
    if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
      curl -fsSL "https://download.docker.com/linux/$OS_ID/gpg" | \
        $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      $SUDO chmod a+r /etc/apt/keyrings/docker.gpg
    fi
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/$OS_ID $(lsb_release -cs) stable" | \
      $SUDO tee /etc/apt/sources.list.d/docker.list >/dev/null
    $SUDO apt-get update -y
    $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io \
      docker-buildx-plugin docker-compose-plugin
  elif [[ "$OS_LIKE" == *"rhel"* ]] || [[ "$OS_LIKE" == *"fedora"* ]] || [[ "$OS_LIKE" == *"centos"* ]]; then
    $SUDO dnf install -y dnf-plugins-core
    $SUDO dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo 2>/dev/null || true
    $SUDO dnf install -y docker-ce docker-ce-cli containerd.io \
      docker-buildx-plugin docker-compose-plugin
  else
    err "توزيعة غير مدعومة لتثبيت Docker تلقائياً: $OS_ID"
    info "ثبّت Docker يدوياً ثم أعد التشغيل مع --skip-docker-install"
    exit 1
  fi

  $SUDO systemctl enable --now docker
  log "Docker مثبت ويعمل"
fi

# ---------- تجهيز المجلدات والإعدادات ----------
title "3/9 تجهيز الإعدادات"

mkdir -p data certbot/conf certbot/www backups logs

# .env
if [[ -f .env ]] && grep -q "^JWT_SECRET=" .env && [[ -n "$(grep '^JWT_SECRET=' .env | cut -d= -f2)" ]]; then
  log ".env موجود مسبقاً — لن يُعاد توليده"
else
  JWT_SECRET=$(openssl rand -hex 32)
  cat > .env <<EOF
JWT_SECRET=$JWT_SECRET
EOF
  chmod 600 .env
  log "تم إنشاء .env مع JWT_SECRET عشوائي"
fi

# تعيين صلاحيات مجلد البيانات (لتفادي مشاكل SQLite)
if [[ -d data ]]; then chmod 755 data; fi

# ---------- إعداد Nginx (وضعين: HTTP للاختبار / SSL للإنتاج) ----------
title "4/9 إعداد Nginx"

if [[ $LOCAL_MODE -eq 1 ]]; then
  # وضع محلي: منفذ 80 فقط، بدون SSL
  cat > nginx.conf <<'NGINX'
server {
    listen 80;
    server_name _;
    client_max_body_size 10M;
    location / {
        proxy_pass http://app:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 24h;
        proxy_set_header Connection '';
    }
}
NGINX
  log "تم إعداد Nginx للوضع المحلي"
else
  # وضع إنتاجي — مرحلة أولى: HTTP فقط لجلب الشهادة
  cat > nginx.conf <<NGINX
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / {
        proxy_pass http://app:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 24h;
        proxy_set_header Connection '';
    }
}
NGINX
  log "تم إعداد Nginx مؤقتاً (HTTP فقط لجلب SSL)"
fi

# ---------- تشغيل الحاويات ----------
title "5/9 تشغيل الحاويات"

$SUDO docker compose down --remove-orphans 2>/dev/null || true
$SUDO docker compose up -d --build app nginx

# انتظار جهوزية التطبيق
info "انتظار جهوزية التطبيق..."
READY=0
for i in $(seq 1 30); do
  if $SUDO docker compose exec -T app wget -qO- http://localhost:3000/manifest.json >/dev/null 2>&1; then
    READY=1; break
  fi
  sleep 2
done

if [[ $READY -eq 1 ]]; then
  log "التطبيق جاهز (منفذ 3000 داخلياً)"
else
  err "التطبيق لم يجهز خلال 60 ثانية. تحقق من السجلات:"
  info "$SUDO docker compose logs --tail=50 app"
  exit 1
fi

# ---------- فحص DNS ----------
if [[ $LOCAL_MODE -eq 0 ]]; then
  title "6/9 فحص DNS"
  DOMAIN_IP=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
  SERVER_IP=$(curl -s --max-time 10 https://api.ipify.org || echo "unknown")

  if [[ -z "$DOMAIN_IP" ]]; then
    warn "تعذّر الوصول إلى $DOMAIN عبر DNS. تأكد من ربطه بـ $SERVER_IP قبل المتابعة."
    read -r -p "هل تريد المتابعة على أي حال؟ [y/N] " ans
    [[ "$ans" =~ ^[Yy]$ ]] || { err "تم الإلغاء"; exit 1; }
  elif [[ "$DOMAIN_IP" != "$SERVER_IP" ]]; then
    warn "IP الدومين ($DOMAIN_IP) لا يطابق IP الخادم ($SERVER_IP)."
    read -r -p "هل تريد المتابعة على أي حال؟ [y/N] " ans
    [[ "$ans" =~ ^[Yy]$ ]] || { err "تم الإلغاء"; exit 1; }
  else
    log "DNS صحيح: $DOMAIN → $SERVER_IP"
  fi

  # ---------- إصدار شهادة SSL ----------
  title "7/9 إصدار شهادة SSL"

  CERT_PATH="certbot/conf/live/$DOMAIN/fullchain.pem"
  if [[ -f "$CERT_PATH" ]]; then
    log "شهادة SSL موجودة مسبقاً — تخطي الإصدار"
  else
    info "طلب شهادة Let's Encrypt..."
    $SUDO docker compose run --rm --entrypoint certbot certbot certonly \
      --webroot -w /var/www/certbot \
      -d "$DOMAIN" \
      --email "$EMAIL" \
      --agree-tos --no-eff-email \
      --non-interactive || {
        err "فشل إصدار الشهادة. تحقق من DNS ومن أن المنفذ 80 مفتوح."
        info "السجلات: $SUDO docker compose logs nginx"
        exit 1
      }
    log "تم إصدار الشهادة بنجاح"
  fi

  # تبديل Nginx إلى وضع SSL
  cat > nginx.conf <<NGINX
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    client_max_body_size 10M;

    location / {
        proxy_pass http://app:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 24h;
        proxy_set_header Connection '';
    }
}
NGINX
  $SUDO docker compose exec -T nginx nginx -s reload
  log "Nginx يعمل الآن مع SSL"

  # بدء خدمة التجديد التلقائي
  $SUDO docker compose up -d certbot
  log "تجديد SSL التلقائي مُفعّل (كل 12 ساعة)"
fi

# ---------- الجدار الناري ----------
title "8/9 الجدار الناري"

if command -v ufw >/dev/null 2>&1; then
  if $SUDO ufw status | grep -q "Status: active"; then
    $SUDO ufw allow 22/tcp  >/dev/null 2>&1 || true
    $SUDO ufw allow 80/tcp  >/dev/null 2>&1 || true
    $SUDO ufw allow 443/tcp >/dev/null 2>&1 || true
    log "تم فتح المنافذ 22، 80، 443 في ufw"
  else
    warn "ufw غير مُفعّل — لن يتم تعديله"
  fi
elif command -v firewall-cmd >/dev/null 2>&1; then
  if systemctl is-active --quiet firewalld; then
    $SUDO firewall-cmd --permanent --add-service=ssh    >/dev/null
    $SUDO firewall-cmd --permanent --add-service=http   >/dev/null
    $SUDO firewall-cmd --permanent --add-service=https  >/dev/null
    $SUDO firewall-cmd --reload                         >/dev/null
    log "تم فتح المنافذ في firewalld"
  fi
else
  warn "لا يوجد جدار ناري معروف — تأكد يدوياً من فتح 80/443"
fi

# ---------- النسخ الاحتياطي التلقائي ----------
title "9/9 النسخ الاحتياطي التلقائي"

cat > backup.sh <<'BACKUP'
#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
DATE=$(date +%F-%H%M)
mkdir -p backups
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 ./data/queue.db ".backup ./backups/queue-$DATE.db"
else
  cp ./data/queue.db "./backups/queue-$DATE.db"
fi
find ./backups -name "queue-*.db" -mtime +14 -delete
echo "[$(date)] Backup: queue-$DATE.db"
BACKUP
chmod +x backup.sh

# إضافة cron إن لم تكن موجودة
CRON_LINE="0 3 * * * cd $PROJECT_DIR && ./backup.sh >> $PROJECT_DIR/logs/backup.log 2>&1"
if ! crontab -l 2>/dev/null | grep -qF "backup.sh >> $PROJECT_DIR"; then
  ( crontab -l 2>/dev/null; echo "$CRON_LINE" ) | crontab -
  log "تم جدولة النسخ الاحتياطي اليومي (الساعة 3:00 صباحاً)"
else
  log "النسخ الاحتياطي مُجدول مسبقاً"
fi

# ---------- ملخص نهائي ----------
title "🎉 اكتمل النشر بنجاح"

if [[ $LOCAL_MODE -eq 1 ]]; then
  BASE_URL="http://localhost"
  info "الوضع: محلي (بدون SSL)"
else
  BASE_URL="https://$DOMAIN"
  info "الوضع: إنتاجي مع SSL"
fi

SERVER_IP=$(curl -s --max-time 5 https://api.ipify.org || echo "<IP>")

cat <<EOF

${BOLD}🌐 الروابط:${NC}
  🎫 الكشك:       $BASE_URL/kiosk/demo
  📺 الشاشة:      $BASE_URL/display/demo
  👨‍💼 الموظف:     $BASE_URL/agent/demo
  🔐 الإدارة:     $BASE_URL/login
  🌐 المزوّد:     $BASE_URL/login

${BOLD}🔑 بيانات الدخول الافتراضية:${NC}
  مدير المركز:     admin / admin123
  مدير المزوّد:    super / super123

${YELLOW}⚠️  غيّر كلمات المرور فوراً من لوحة الإدارة!${NC}

${BOLD}📋 أوامر مفيدة:${NC}
  عرض السجلات:        $SUDO docker compose logs -f app
  إعادة التشغيل:      $SUDO docker compose restart
  تحديث التطبيق:      $SUDO docker compose up -d --build app
  نسخ احتياطي يدوي:   ./backup.sh
  إيقاف كل شيء:       $SUDO docker compose down

${BOLD}📂 الملفات:${NC}
  قاعدة البيانات:     $PROJECT_DIR/data/queue.db
  النسخ الاحتياطية:   $PROJECT_DIR/backups/
  شهادة SSL:          $PROJECT_DIR/certbot/conf/live/$DOMAIN/

${BOLD}🔗 التكامل مع Motivity:${NC}
  من لوحة الإدارة ← إعدادات Motivity ← ضع رابط الـ Webhook

EOF

if [[ $LOCAL_MODE -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}✅ النظام جاهز على: $BASE_URL${NC}\n"
else
  echo -e "${GREEN}${BOLD}✅ النظام جاهز محلياً على: http://$SERVER_IP/${NC}\n"
fi
