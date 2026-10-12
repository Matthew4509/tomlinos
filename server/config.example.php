<?php
// Settings for the desktop's server. Copy to config.php (git-ignored) to change them; without a config.php
// these defaults apply.
return [
    // Where the files and the accounts are kept. Must be OUTSIDE the web root, so nothing can ever be fetched or run
    // directly. The default is ../desktop-data, beside the repository (not inside it).
    // The tests point it at a throw-away folder with the DESKTOP_DATA_DIR environment variable.
    'data_dir' => getenv('DESKTOP_DATA_DIR') ?: dirname(__DIR__, 2) . '/desktop-data',

    // Where on-device AI models are kept; signed-in people get them at /models/ through api/modelfile.php. Empty =
    // tomlinos/models on a live host (beside data/), models/ in the repository here. Never inside public_html. The tests
    // point it at a throw-away folder.
    'models_dir' => (string) getenv('DESKTOP_MODELS_DIR'),

    // Largest single save, in bytes. PHP's post_max_size also limits it (the smaller wins); there is no upload in pieces yet.
    'max_commit_bytes' => 256 * 1024 * 1024,

    // false: only this computer can reach the desktop. Sign-in, two-step codes and the server-held lock now exist, but
    // the security pass has not been run yet; turn this on for a live host only after it, and only over HTTPS.
    'allow_remote' => false,

    // The name shown in authenticator apps next to the six-digit codes.
    'site_name' => 'TOMLIN OS',

    // Storage each person may use, in MB (0 = no limit). Deleting always works, even when full.
    'quota_mb' => (int) (getenv('DESKTOP_QUOTA_MB') ?: 2048),

    // The most files and folders each person may keep (0 = no limit). Every hosting account has a limit on the number
    // of files ("inodes"); this keeps one person from using it all up. Deleting always works, even at the limit.
    'max_files' => (int) (getenv('DESKTOP_MAX_FILES') ?: 50000),

    // Addresses that are never held by the sign-in brakes or asked for the picture check (your home or office, if its
    // address does not change), for example ['203.0.113.7', '2001:db8:1234:5678::1']. An IPv6 address covers its /64.
    'trusted_ips' => [],

    // The sender of unlock emails ("Email me an unlock link" on the sign-in screen), for example
    // 'no-reply@example.com'. Empty: the host's own default sender.
    'mail_from' => '',

    // The most people this desktop holds (the owner adds them; there is no open sign-up).
    'max_users' => 10,

    // A session ends after this many hours with no request, and after this many days whatever happens.
    'session_idle_hours' => 12,
    'session_days' => 30,

    // Mail: the server connects only to public mail servers on mail ports, always encrypted. A mail server on your
    // own network is listed here as 'host:port' (e.g. '192.168.1.5:993') so Mail may reach it; unencrypted connections
    // are allowed only to listed hosts, and only when mail_allow_plain is true. The tests set both for a local stand-in.
    'mail_allow_hosts' => array_values(array_filter(explode(',', (string) getenv('DESKTOP_MAIL_ALLOW_HOSTS')))),
    'mail_allow_plain' => getenv('DESKTOP_MAIL_ALLOW_PLAIN') === '1',
];
