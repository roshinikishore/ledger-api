# Deploying to AWS (EC2 + Docker)

One small server runs everything: the API, the frontend page, and the SQLite database file.

```
Browser  ->  EC2 server (Docker container)  ->  /data/ledger.db  (on the server's disk)
```

## Why EC2 + SQLite?

- **Simple and cheap**: one `t3.micro`/`t2.micro` instance (free tier eligible in many accounts).
- **SQLite needs a disk that survives restarts.** Services with throw-away disks (Lambda, App Runner, ECS Fargate without a volume) would lose the data, so a plain EC2 server with its own disk is the easiest correct choice.
- **Trade-off**: one server only, no automatic scaling. For real production, move to Amazon RDS (Postgres); the SQL in `src/db.js` and `src/ledger.js` would need small changes.

## Steps (AWS Console)

1. **Launch an instance**: EC2 -> Launch instance.
   - AMI: Amazon Linux 2023. Type: `t3.micro`. Create or choose a key pair.
   - Security group inbound rules: SSH (22) from **My IP only**, and Custom TCP **3000** from anywhere (or HTTP 80 if you map it, see below).
2. **Connect** with EC2 Instance Connect or SSH, then install Docker and git:
   ```bash
   sudo dnf install -y docker git
   sudo systemctl enable --now docker
   sudo usermod -aG docker ec2-user && newgrp docker
   ```
3. **Get the code onto the server** (clone your repo, or `scp` the project folder).
4. **Build and run** (the `-v` flag keeps the database on the server's disk, and `--restart` brings it back after a reboot):
   ```bash
   cd ledger-api
   docker build -t ledger .
   docker run -d --name ledger --restart unless-stopped -p 80:3000 -v ledger-data:/data ledger
   ```
   Use `-p 80:3000` and open port 80 in the security group to browse without typing `:3000`.
5. **Open it**: `http://<EC2-public-IP>/` shows the frontend. `http://<EC2-public-IP>/accounts/<id>/balance` is an API call.

## Check it works

```bash
curl http://<EC2-public-IP>/accounts -X POST -H 'content-type: application/json' -d '{"name":"Test"}'
docker logs ledger
```

## Backups

The data is the `ledger-data` Docker volume. Take an EBS snapshot of the instance's disk regularly.

## Security notes (be ready to talk about these)

- There is **no login**: anyone who can reach the URL can use the API. Fine for a demo, not for real money.
- Traffic is plain HTTP. Put CloudFront or an Application Load Balancer with an ACM certificate in front for HTTPS.
- SSH is restricted to your IP. Nothing secret is stored in the code (no keys or passwords).
- Stop or terminate the instance after the review so you aren't billed.
