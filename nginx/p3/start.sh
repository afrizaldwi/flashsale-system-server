#!/bin/sh
set -eu
mkdir -p /etc/nginx/p3
cp /opt/p3/bootstrap.conf /etc/nginx/p3/active.conf
exec nginx -c /etc/nginx/p3/active.conf -g 'daemon off;'
