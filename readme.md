# Shared Workspace
<br>

---
<br>

## Project Overview
This is a serverless connectivity project between 2 browsers. They Share clipboard, a temporary text area also enable to transfer files and chat. For this I used **webRTC**

---
## Why **webRTC**?
This project is based on w**ebRTC** (web Real Time Connection) which is operating on **SDP** (Session Description Protocol), a text based format. 
<br>
The main advantage of this is that it connects the browsers directly removing the dependency of servers unlike websockets
<br>
(other example of **SDP** based protocol is **VoIP**)

---
## Other Tech I used
For connecting devices over **webRTC** they had to exachange handshakes on a temporary signaling channel for that I used **ntfy.sh** and Google's public **STUN** servers 


