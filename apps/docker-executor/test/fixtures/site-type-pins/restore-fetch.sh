set -eu
S=/var/tmp/c
RO="-o s3.bucket-lookup=path"
db_ls=$(restic $RO -o "s3.region=$HP_REGION" ls --json "$HP_SNAP" /backup/databases)
dumps_need=$(printf '%s\n' "$db_ls" | awk -F'"size":' '/"type":"file"/{split($2,a,/[,}]/); sum+=a[1]} END{printf "%.0f\n", sum+0}')
db_count=$(printf '%s\n' "$db_ls" | awk '/"type":"file"/{n++} END{print n+0}')
free_s=$(df -Pk /var/tmp | awk 'NR==2{print $4}')
[ $((free_s * 1024)) -ge $((dumps_need + HP_FLOOR)) ] || exit 75
rm -rf "$S"
mkdir -m 0700 "$S" "$S/databases"
if [ "$db_count" -gt 0 ]; then
  restic $RO -o "s3.region=$HP_REGION" restore "$HP_SNAP:/backup/databases" --target "$S/databases"
fi
bad_db=$(find "$S/databases" -mindepth 1 \( ! -type f -o ! -name '*.sql' \) | head -n 1)
[ -z "$bad_db" ] || exit 95
: > "$S/dbs.tmp"
for f in "$S/databases"/*.sql; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  db=${f##*/}
  db=${db%.sql}
  printf '%s\n' "$db" >> "$S/dbs.tmp"
done
sort -u "$S/dbs.tmp" -o "$S/dbs.tmp"
sync "$S/dbs.tmp"; mv -Tf "$S/dbs.tmp" "$S/dbs"; sync "$S"
du -sk "$S/databases" | cut -f1