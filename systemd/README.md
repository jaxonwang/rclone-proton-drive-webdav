# Example systemd units

A long unattended backup needs three things this project does not provide on its
own: the bridge running, something that restarts the copy after a reboot, and a
guard so an unmounted source cannot look like a finished upload.

These are the units used for a real ~230 GiB backup over a ~1 MB/s link. They are
**examples**: replace `YOURUSER`, the workspace path, and the source/destination.

```bash
sudo install -m 644 proton-rclone-bridge.service /etc/systemd/system/
sudo install -m 644 proton-rclone-copy.service   /etc/systemd/system/
sudo install -m 644 proton-rclone-copy.timer     /etc/systemd/system/
install -m 700 copy.sh ~/.local/state/proton-rclone/copy.sh
sudo systemctl daemon-reload
sudo systemctl enable --now proton-rclone-bridge.service
sudo systemctl enable --now proton-rclone-copy.timer
```

System units with `User=` are used rather than user units, so the job survives
logout and reboot **without** enabling lingering.

## Why it is shaped this way

- **The timer is the reboot recovery mechanism.** rclone keeps no journal, and
  `--retries` only applies inside one process, so nothing in the copy command
  survives a reboot. Re-running it does, because `rclone copy` re-derives what is
  left from the remote every time.
- **Retries are low on purpose.** There is no byte-level resume, so each retry
  re-sends a whole file. `--low-level-retries 1`, and let the timer retry.
- **`--timeout 0` is mandatory**, not tuning. A `PUT` is answered only after
  Proton commits, and the default 5-minute idle timeout kills any upload slower
  than that. See the main README.
- **The source guard refuses to run** if the source is not mounted. An unmounted
  filesystem presents as an empty directory, which is indistinguishable from
  "everything already uploaded".
- **`RestartPreventExitStatus=3`** on the bridge: exit 3 means "authenticate
  first", which restarting cannot fix.
- **A `COMPLETE` marker** stops the timer re-hashing the whole source every
  interval once a pass has finished cleanly. Delete it to force a fresh pass.
  It is written only when the remote file count matches the **live** source, not
  merely when rclone exits 0 — see below.
- **One `flock`** means a copy can never overlap itself; a duplicate exits 73.
- **Exit 0 is not the same as "everything is backed up."** rclone freezes its work
  set when it finishes listing, which on a large tree is minutes into a run that
  lasts days. Files added to the source after that are not in the set, so a pass
  can legitimately exit 0 with new data un-uploaded. Trusting exit 0 to write the
  marker would stop the timer and lose them silently. This happened in real use:
  three files were dropped into the source mid-pass, and the only reason they were
  not buried is that the marker now requires the remote count to match the live
  source.
