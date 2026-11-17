set -eu
W=/var/www/html; R=/var/www/html/.hp_rs_$HP_H; S=/var/tmp/c
RO="-o s3.bucket-lookup=path"
stats_out=$(restic $RO -o "s3.region=$HP_REGION" stats --json --mode restore-size "$HP_SNAP")
total_need=$(printf '%s\n' "$stats_out" | sed -n 's/.*"total_size":\([0-9]*\).*/\1/p')
[ -n "$total_need" ]
db_ls=$(restic $RO -o "s3.region=$HP_REGION" ls --json "$HP_SNAP" /backup/databases)
dumps_need=$(printf '%s\n' "$db_ls" | awk -F'"size":' '/"type":"file"/{split($2,a,/[,}]/); sum+=a[1]} END{printf "%.0f\n", sum+0}')
db_count=$(printf '%s\n' "$db_ls" | awk '/"type":"file"/{n++} END{print n+0}')
files_need=$((total_need - dumps_need)); [ "$files_need" -ge 0 ] || files_need=$total_need
free_w=$(df -Pk "$W" | awk 'NR==2{print $4}')
free_s=$(df -Pk /var/tmp | awk 'NR==2{print $4}')
if [ "$(stat -c %d "$W")" = "$(stat -c %d /var/tmp)" ]; then
  [ $((free_w * 1024)) -ge $((total_need + HP_FLOOR)) ] || exit 75
else
  [ $((free_w * 1024)) -ge $((files_need + HP_FLOOR)) ] || exit 75
  [ $((free_s * 1024)) -ge $((dumps_need + HP_FLOOR)) ] || exit 75
fi
rm -rf "$R"
mkdir -m 0700 "$R"
(set -C; printf 'Require all denied\n' > "$R/.htaccess")
mkdir -m 0755 "$R/c" "$R/c/files"
rm -rf "$S"
mkdir -m 0700 "$S" "$S/databases"
restic $RO -o "s3.region=$HP_REGION" restore "$HP_SNAP:/backup/files" --target "$R/c/files"
if [ "$db_count" -gt 0 ]; then
  restic $RO -o "s3.region=$HP_REGION" restore "$HP_SNAP:/backup/databases" --target "$S/databases"
fi
bad_db=$(find "$S/databases" -mindepth 1 \( ! -type f -o ! -name '*.sql' \) | head -n 1)
[ -z "$bad_db" ] || exit 95
! find "$W" "$R/c/files" -mindepth 1 -maxdepth 3 -name '*
*' | grep -q . || exit 95
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