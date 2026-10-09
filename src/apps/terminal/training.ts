// The pretend Debian training machine behind `ssh training`: a small file system in this page's memory, made fresh
// on every login and thrown away on exit. Its files are a short course: each lesson is something a person really does
// on a Debian server (look around, read a log, find a file, tidy a folder, copy a file home with scp).
import { FileSystem } from '../../fs/fs.ts';
import { joinPath, parentPath } from '../../fs/names.ts';
import { MemoryStore } from '../../store/memory-store.ts';
import type { Machine } from './shell.ts';

export const TRAINING_OS_RELEASE = `PRETTY_NAME="Debian GNU/Linux 13 (trixie) - TOMLIN OS training machine (pretend)"
NAME="Debian GNU/Linux"
VERSION_ID="13"
VERSION="13 (trixie)"
VERSION_CODENAME=trixie
ID=debian
HOME_URL="(none: this machine lives in your browser)"
`;

const README = `Welcome to the training machine.

This is a PRETEND Debian server. It lives inside this page: nothing here reaches the internet, your computer,
or your real files, and everything is reset when you type exit. Break things freely.

Lessons (type the commands after the $):

 1. Look around
      $ pwd                 where am I?
      $ ls -l               what is here, with sizes and dates
      $ cd notes            go into a folder;  cd .. comes back up;  cd alone goes home
      $ cat tips.txt        read a file

 2. Read a log, the way you would on a real server
      $ tail -n 5 /var/log/syslog
      $ grep -i error /var/log/syslog
      $ grep -rn backup /var/log

 3. Find things
      $ find / -name "*.conf"
      $ find ~ -type d
      $ ls -a               "hidden" items only show with -a ... there is one in this folder

 4. Tidy up (on this machine rm really deletes; on your desktop it goes to the Recycle Bin)
      $ mkdir old
      $ mv projects/draft.txt old/
      $ cp -r notes notes-copy
      $ rm -r notes-copy
      $ echo "done lesson 4" >> progress.txt

 5. Bring a file home
      $ exit                back to your desktop
      $ scp training:notes/tips.txt ~/Documents
`;

const TIPS = `Debian tips
- Tab completes names: type "cat ti" then Tab.
- Up and down arrows bring back earlier commands; "history" lists them.
- Quotes keep spaces together: mkdir "My Folder".
- "*" matches anything: ls *.txt, rm old/*.bak
- Ctrl+C abandons the line you are typing; Ctrl+L (or clear) clears the screen.
`;

const SYSLOG = `Sep 26 06:25:01 training CRON[811]: (root) CMD (test -x /usr/sbin/anacron || run-parts --report /etc/cron.daily)
Sep 26 06:25:03 training backup.sh[820]: starting nightly backup of /home
Sep 26 06:25:44 training backup.sh[820]: backup finished: 1,284 files, 212 MB
Sep 26 07:02:17 training sshd[902]: Accepted password for learner from 10.0.0.2 port 51022 ssh2
Sep 26 07:40:09 training kernel: [ 3021.114] EXT4-fs (sda1): error count since last fsck: 0
Sep 26 08:13:55 training nginx[455]: 2026/09/26 08:13:55 [error] 455#455: *17 open() "/var/www/html/favicon.ico" failed (2: No such file or directory)
Sep 26 09:00:00 training systemd[1]: Starting apt-daily-upgrade.service - Daily apt upgrade and clean activities...
Sep 26 09:00:12 training systemd[1]: apt-daily-upgrade.service: Deactivated successfully.
`;

const FILES: Record<string, string> = {
  '/home/learner/README.txt': README,
  '/home/learner/notes/tips.txt': TIPS,
  '/home/learner/notes/servers.txt': 'web01   10.0.0.31   nginx\ndb01    10.0.0.32   postgresql\nbackup  10.0.0.40   nightly at 06:25\n',
  '/home/learner/projects/draft.txt': 'An old draft. Lesson 4 moves it into a folder called old.\n',
  '/home/learner/projects/hello.sh': '#!/bin/sh\necho "Hello from the training machine"\n',
  '/etc/hostname': 'training\n',
  '/etc/os-release': TRAINING_OS_RELEASE,
  '/etc/nginx/nginx.conf': 'user www-data;\nworker_processes auto;\n\nevents { worker_connections 768; }\n\nhttp {\n    include /etc/nginx/sites-enabled/*;\n}\n',
  '/etc/ssh/sshd_config': '# Pretend settings, for reading only.\nPermitRootLogin no\nPasswordAuthentication yes\n',
  '/var/log/syslog': SYSLOG,
  '/var/log/backup.log': 'Sep 25 06:25:44 backup finished: 1,279 files\nSep 26 06:25:44 backup finished: 1,284 files\n',
};

export async function makeTrainingMachine(): Promise<Machine> {
  const fs = new FileSystem(new MemoryStore());
  // A new file system starts with the desktop's own folders (Desktop, Documents...); a Debian machine has none of them.
  await fs.remove((await fs.list('/', true)).map(e => `/${e.name}`));
  for (const [path, text] of Object.entries(FILES)) {
    await fs.ensureFolder(parentPath(path));
    await fs.writeText(path, text);
  }
  await fs.ensureFolder('/home/learner/.secret', { hidden: true });
  await fs.writeText('/home/learner/.secret/well-done.txt', 'You found the hidden folder. On Debian, names starting with a dot are hidden until ls -a.\n');
  await fs.ensureFolder('/tmp');
  return {
    fs,
    user: 'learner',
    host: 'training',
    home: '/home/learner',
    pretend: true,
    protectedReason: path => (['/', '/home', '/home/learner', '/etc', '/var', '/var/log'].includes(joinPath(path)) ? 'Permission denied' : null),
    async trash(paths) {
      await fs.remove(paths);
      return '';
    },
  };
}
