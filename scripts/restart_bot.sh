#!/bin/bash
sleep 3
pkill -f "opencode serve" 2>/dev/null
pkill -f "tsx watch" 2>/dev/null
pkill -f "concurrently" 2>/dev/null
pkill -f "python.*server.py" 2>/dev/null
sleep 2
cd /root/project/dingtalk-opencode
rm -f data/session-map.json data/project-context.json 2>/dev/null
nohup npm run start:all >> data/app.log 2>&1 &
