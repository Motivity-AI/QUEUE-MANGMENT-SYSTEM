#!/bin/bash
# نسخ احتياطي لقاعدة البيانات (SQLite)
set -e
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

DATE=$(date +%F-%H%M)
mkdir -p backups

# نسخ احتياطي آمن باستخدام SQLite .backup (لا يوقف التطبيق)
sqlite3 ./data/queue.db ".backup ./backups/queue-$DATE.db" 2>/dev/null || \
  cp ./data/queue.db ./backups/queue-$DATE.db

# حذف النسخ الأقدم من 14 يوماً
find ./backups -name "queue-*.db" -mtime +14 -delete

echo "✅ Backup created: backups/queue-$DATE.db"