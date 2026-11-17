set -eu
W=/var/www/html; R=$W/.hp_rs_$HP_H; F=$R/c/files; P=$R/c/plan
case "$HP_H" in *[!0-9a-f]*) exit 1;; esac
[ "${#HP_H}" -eq 32 ] || exit 1
case "$HP_STEP" in
switch)
  [ ! -f "$P" ] || exit 93
  for p in "$W/wp-content" "$W/wp-content/mu-plugins" "$F/wp-content" "$F/wp-content/mu-plugins"; do
    [ ! -L "$p" ] || exit 1
  done
  mkdir -p "$W/wp-content/mu-plugins" "$F/wp-content/mu-plugins"
  : > "$P.tmp"
  for d in "" wp-content/ wp-content/mu-plugins/; do
    l1=$(ls -A "$W/$d")
    l2=$(ls -A "$F/$d")
    { [ -z "$l1" ] || printf '%s\n' "$l1"; [ -z "$l2" ] || printf '%s\n' "$l2"; } | sort -u | while IFS= read -r e; do
      [ -n "$e" ] || continue
      case "$d$e" in
        .maintenance|.maintenance.hp*|.hp_rs_*|wp-content|wp-content/mu-plugins|wp-content/mu-plugins/hp-mail.php) continue ;;
      esac
      if [ -e "$W/$d$e" ] || [ -L "$W/$d$e" ]; then
        if [ -e "$F/$d$e" ] || [ -L "$F/$d$e" ]; then
          printf 'X\t%s\t%s\n' "$(stat -c %i "$W/$d$e")" "$d$e"
        else
          printf 'O\t-\t%s\n' "$d$e"
        fi
      else
        printf 'I\t-\t%s\n' "$d$e"
      fi
    done >> "$P.tmp"
  done
  sync "$P.tmp"; mv -Tf "$P.tmp" "$P"; sync "$R/c"
  while IFS="$(printf '\t')" read -r k i e; do
    case "$k" in
      X) mv --exchange -T "$F/$e" "$W/$e" ;;
      I) mv -T "$F/$e" "$W/$e" ;;
      O) mv -T "$W/$e" "$F/$e" ;;
    esac
  done < "$P"
  sync "$W" ;;
undo)
  [ -f "$P" ] || exit 0
  tac "$P" | while IFS="$(printf '\t')" read -r k i e; do
    case "$k" in
      X) [ "$(stat -c %i "$W/$e")" = "$i" ] || mv --exchange -T "$F/$e" "$W/$e" ;;
      I) if [ -e "$W/$e" ] || [ -L "$W/$e" ]; then [ -e "$F/$e" ] || [ -L "$F/$e" ] || mv -T "$W/$e" "$F/$e"; fi ;;
      O) if [ -e "$F/$e" ] || [ -L "$F/$e" ]; then [ -e "$W/$e" ] || [ -L "$W/$e" ] || mv -T "$F/$e" "$W/$e"; fi ;;
    esac
  done
  rm -f "$P"; sync "$W" ;;
*) exit 1 ;;
esac