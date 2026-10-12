<?php
declare(strict_types=1);

header("Cache-Control: no-store");
header("Content-Type: application/json; charset=utf-8");

$root = __DIR__;
$dataDir = $root . DIRECTORY_SEPARATOR . "data";
$imageDir = $root . DIRECTORY_SEPARATOR . "images";
$route = (string) ($_GET["r"] ?? "");
$method = $_SERVER["REQUEST_METHOD"] ?? "GET";

session_set_cookie_params([
    "lifetime" => 12 * 3600,
    "path" => "/",
    "httponly" => true,
    "samesite" => "Lax",
    "secure" => (!empty($_SERVER["HTTPS"]) && $_SERVER["HTTPS"] !== "off"),
]);
session_start();

function send_json(int $status, $body): void {
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_SLASHES);
    exit;
}

function data_path(string $name): string {
    global $dataDir;
    return $dataDir . DIRECTORY_SEPARATOR . $name;
}

function read_json(string $name) {
    $path = data_path($name);
    if (!is_readable($path)) {
        send_json(500, ["error" => "Could not read {$name}."]);
    }
    $decoded = json_decode((string) file_get_contents($path), true);
    if (!is_array($decoded)) {
        send_json(500, ["error" => "Could not read {$name}."]);
    }
    return $decoded;
}

function write_json(string $name, $value): void {
    $ok = file_put_contents(data_path($name), json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
    if ($ok === false) {
        send_json(500, ["error" => "Could not write {$name}. Check that the data folder is writable."]);
    }
}

function read_settings(): array {
    $path = data_path("settings.json");
    if (!is_readable($path)) {
        return ["sponsorNotice" => ""];
    }
    $decoded = json_decode((string) file_get_contents($path), true);
    $notice = is_array($decoded) ? trim((string) ($decoded["sponsorNotice"] ?? "")) : "";
    if (strlen($notice) > 400) {
        $notice = substr($notice, 0, 400);
    }
    return ["sponsorNotice" => $notice];
}

function write_settings(array $value): array {
    $notice = trim((string) ($value["sponsorNotice"] ?? ""));
    if (strlen($notice) > 400) {
        $notice = substr($notice, 0, 400);
    }
    $settings = ["sponsorNotice" => $notice];
    write_json("settings.json", $settings);
    return $settings;
}

function log_activity(array $entry): void {
    $current = read_json("activity.json");
    $current[] = array_merge(["at" => gmdate("c")], $entry);
    write_json("activity.json", $current);
}

function public_user(?array $user): ?array {
    if (!$user) {
        return null;
    }
    return [
        "username" => $user["username"],
        "role" => $user["role"],
        "organisationId" => $user["organisationId"] ?? null,
    ];
}

function current_user(): ?array {
    $username = strtolower((string) ($_SESSION["username"] ?? ""));
    if ($username === "") {
        return null;
    }
    foreach (read_json("users.json") as $user) {
        if (($user["username"] ?? "") === $username) {
            return $user;
        }
    }
    return null;
}

function require_user(): array {
    $user = current_user();
    if (!$user) {
        send_json(401, ["error" => "Sign in to continue."]);
    }
    return $user;
}

function require_admin(): array {
    $user = require_user();
    if (($user["role"] ?? "") !== "site-admin") {
        send_json(403, ["error" => "Only the site admin can do that."]);
    }
    return $user;
}

function is_admin(array $user): bool {
    return ($user["role"] ?? "") === "site-admin";
}

function verify_password(string $password, array $user): bool {
    $salt = (string) ($user["salt"] ?? "");
    $hash = (string) ($user["hash"] ?? "");
    if ($salt === "" || $hash === "") {
        return false;
    }
    $iterations = (int) ($user["iterations"] ?? 120000);
    $calc = bin2hex(hash_pbkdf2("sha256", $password, $salt, $iterations, 64, true));
    return hash_equals($hash, $calc);
}

function hash_password(string $password): array {
    $salt = bin2hex(random_bytes(16));
    $iterations = 120000;
    return [
        "algo" => "pbkdf2",
        "iterations" => $iterations,
        "salt" => $salt,
        "hash" => bin2hex(hash_pbkdf2("sha256", $password, $salt, $iterations, 64, true)),
    ];
}

function sites_for_user(array $sites, array $user): array {
    if (is_admin($user)) {
        return $sites;
    }
    $org = $user["organisationId"] ?? "";
    return array_values(array_filter($sites, fn($site) => ($site["organisationId"] ?? "") === $org));
}

function orgs_for_user(array $orgs, array $user): array {
    if (is_admin($user)) {
        return $orgs;
    }
    $org = $user["organisationId"] ?? "";
    return array_values(array_filter($orgs, fn($item) => ($item["id"] ?? "") === $org));
}

function find_org(array $orgs, string $id): ?array {
    foreach ($orgs as $org) {
        if (($org["id"] ?? "") === $id) {
            return $org;
        }
    }
    return null;
}

function read_body(): string {
    return (string) file_get_contents("php://input");
}

function read_json_body() {
    $decoded = json_decode(read_body(), true);
    if (!is_array($decoded)) {
        send_json(400, ["error" => "Expected JSON."]);
    }
    return $decoded;
}

function subscription_state(string $start): string {
    $from = DateTime::createFromFormat("Y-m-d", $start);
    if (!$from) {
        return "lapsed";
    }
    $today = new DateTime("today");
    $grace = (clone $from)->modify("+12 months");
    $lapse = (clone $from)->modify("+13 months");
    if ($today >= $lapse) {
        return "lapsed";
    }
    if ($today >= $grace) {
        return "grace";
    }
    return "active";
}

function is_listed(array $site, array $org): bool {
    return subscription_state((string) ($org["subscribedAt"] ?? "")) !== "lapsed"
        && subscription_state((string) ($site["createdAt"] ?? "")) !== "lapsed";
}

function parse_photo_code(string $code): ?array {
    if (!preg_match('/^(\d+)-(\d{3})$/', $code, $match)) {
        return null;
    }
    return ["sponsorNumber" => (int) $match[1], "reference" => (int) $match[2]];
}

function next_photo_code(int $sponsor, array $codes): string {
    $max = 0;
    foreach ($codes as $code) {
        $parsed = parse_photo_code((string) $code);
        if ($parsed && $parsed["sponsorNumber"] === $sponsor) {
            $max = max($max, $parsed["reference"]);
        }
    }
    return $sponsor . "-" . str_pad((string) ($max + 1), 3, "0", STR_PAD_LEFT);
}

function collect_codes(array $sites): array {
    $codes = [];
    foreach ($sites as $site) {
        foreach ($site["photos"] ?? [] as $photo) {
            if (!empty($photo["code"])) {
                $codes[] = $photo["code"];
            }
        }
    }
    global $imageDir;
    if (is_dir($imageDir)) {
        foreach (scandir($imageDir) ?: [] as $name) {
            if (preg_match('/^(\d+-\d{3})\.jpe?g$/i', $name, $match)) {
                $codes[] = $match[1];
            }
        }
    }
    return $codes;
}

function apply_restore(array $currentOrgs, array $currentSites, array $backup, array $user): array {
    if (($backup["version"] ?? null) !== 1 || !isset($backup["organisations"], $backup["sites"]) || !is_array($backup["organisations"]) || !is_array($backup["sites"])) {
        send_json(400, ["error" => "That file is not a TouristQR backup."]);
    }
    if (($backup["kind"] ?? "") === "full") {
        if (!is_admin($user)) {
            send_json(403, ["error" => "Only the site admin can restore the whole catalogue."]);
        }
        return ["organisations" => $backup["organisations"], "sites" => $backup["sites"]];
    }
    if (($backup["kind"] ?? "") !== "sponsor") {
        send_json(400, ["error" => "That file is not a TouristQR backup."]);
    }
    $organisationId = $backup["organisationId"] ?? ($backup["organisations"][0]["id"] ?? "");
    if ($organisationId === "") {
        send_json(400, ["error" => "That backup does not name a sponsor."]);
    }
    if (!is_admin($user) && ($user["organisationId"] ?? "") !== $organisationId) {
        send_json(403, ["error" => "You can only restore your own sponsor."]);
    }
    $incomingOrg = $backup["organisations"][0] ?? [];
    $organisations = [];
    $found = false;
    foreach ($currentOrgs as $org) {
        if (($org["id"] ?? "") === $organisationId) {
            $found = true;
            $organisations[] = array_merge($org, [
                "name" => $incomingOrg["name"] ?? $org["name"],
                "email" => $incomingOrg["email"] ?? $org["email"],
                "subscribedAt" => $incomingOrg["subscribedAt"] ?? $org["subscribedAt"],
                "number" => $org["number"],
                "id" => $org["id"],
            ]);
        } else {
            $organisations[] = $org;
        }
    }
    if (!$found) {
        if (!is_admin($user)) {
            send_json(400, ["error" => "That sponsor is not in the catalogue."]);
        }
        $organisations[] = $incomingOrg;
    }
    $other = array_values(array_filter($currentSites, fn($site) => ($site["organisationId"] ?? "") !== $organisationId));
    $mine = array_values(array_filter($backup["sites"], fn($site) => ($site["organisationId"] ?? "") === $organisationId));
    return ["organisations" => $organisations, "sites" => array_merge($other, $mine)];
}

function restore_photos($photos): void {
    global $imageDir;
    if (!is_array($photos)) {
        return;
    }
    if (!is_dir($imageDir)) {
        mkdir($imageDir, 0755, true);
    }
    foreach ($photos as $photo) {
        $code = $photo["code"] ?? "";
        if (!parse_photo_code($code) || empty($photo["jpeg"])) {
            continue;
        }
        file_put_contents($imageDir . DIRECTORY_SEPARATOR . $code . ".jpg", base64_decode($photo["jpeg"]));
    }
}

function collect_backup_photos(array $sites): array {
    global $imageDir, $root;
    $photos = [];
    foreach ($sites as $site) {
        foreach ($site["photos"] ?? [] as $photo) {
            $url = (string) ($photo["url"] ?? "");
            if (strpos($url, "data:") === 0) {
                $photos[] = ["code" => $photo["code"], "dataUrl" => $url];
                continue;
            }
            $file = $imageDir . DIRECTORY_SEPARATOR . ($photo["code"] ?? "") . ".jpg";
            if (is_readable($file)) {
                $photos[] = ["code" => $photo["code"], "jpeg" => base64_encode((string) file_get_contents($file))];
            }
        }
    }
    return $photos;
}

try {
    if ($route === "session" && $method === "GET") {
        send_json(200, ["user" => public_user(current_user())]);
    }

    if ($route === "login" && $method === "POST") {
        $body = read_json_body();
        $username = strtolower(trim((string) ($body["username"] ?? "")));
        $password = (string) ($body["password"] ?? "");
        $found = null;
        foreach (read_json("users.json") as $user) {
            if (($user["username"] ?? "") === $username) {
                $found = $user;
                break;
            }
        }
        if (!$found || !verify_password($password, $found)) {
            send_json(401, ["error" => "Username or password is not correct."]);
        }
        $_SESSION["username"] = $found["username"];
        log_activity(["action" => "login", "username" => $found["username"]]);
        send_json(200, ["user" => public_user($found)]);
    }

    if ($route === "logout" && $method === "POST") {
        $_SESSION = [];
        session_destroy();
        send_json(200, ["user" => null]);
    }

    if ($route === "sites" && $method === "GET") {
        $user = require_user();
        send_json(200, sites_for_user(read_json("sites.json"), $user));
    }

    if ($route === "settings" && $method === "GET") {
        require_user();
        send_json(200, read_settings());
    }

    if ($route === "settings" && $method === "PUT") {
        $admin = require_admin();
        $settings = write_settings(read_json_body());
        log_activity(["action" => "save-notice", "by" => $admin["username"]]);
        send_json(200, $settings);
    }

    if ($route === "organisations" && $method === "GET") {
        $user = require_user();
        send_json(200, orgs_for_user(read_json("organisations.json"), $user));
    }

    if ($route === "photos" && $method === "GET") {
        $user = require_user();
        $sites = sites_for_user(read_json("sites.json"), $user);
        $orgs = orgs_for_user(read_json("organisations.json"), $user);
        $rows = [];
        foreach ($sites as $site) {
            $org = find_org($orgs, (string) ($site["organisationId"] ?? ""));
            foreach ($site["photos"] ?? [] as $photo) {
                $rows[] = array_merge($photo, [
                    "siteId" => $site["id"],
                    "siteName" => $site["name"],
                    "sponsorNumber" => $org["number"] ?? null,
                    "sponsorName" => $org["name"] ?? "",
                ]);
            }
        }
        send_json(200, $rows);
    }

    if ($route === "report" && $method === "GET") {
        require_admin();
        $orgs = read_json("organisations.json");
        $sites = read_json("sites.json");
        $rows = [];
        foreach ($orgs as $org) {
            $mine = array_values(array_filter($sites, fn($site) => ($site["organisationId"] ?? "") === ($org["id"] ?? "")));
            $public = array_values(array_filter($mine, fn($site) => is_listed($site, $org)));
            $rows[] = [
                "organisationId" => $org["id"],
                "number" => $org["number"],
                "name" => $org["name"],
                "email" => $org["email"],
                "subscribedAt" => $org["subscribedAt"],
                "state" => subscription_state((string) ($org["subscribedAt"] ?? "")),
                "siteCount" => count($mine),
                "publicCount" => count($public),
            ];
        }
        send_json(200, $rows);
    }

    if ($route === "users" && $method === "POST") {
        $admin = require_admin();
        $body = read_json_body();
        $username = strtolower(trim((string) ($body["username"] ?? "")));
        $password = (string) ($body["password"] ?? "");
        $organisationId = trim((string) ($body["organisationId"] ?? ""));
        if (!preg_match('/^[a-z0-9._-]{3,40}$/', $username)) {
            send_json(400, ["error" => "A username uses 3–40 letters, numbers, dots, hyphens, or underscores."]);
        }
        if (strlen($password) < 8) {
            send_json(400, ["error" => "Give the sponsor a password of at least 8 characters."]);
        }
        if (!find_org(read_json("organisations.json"), $organisationId)) {
            send_json(400, ["error" => "Choose a sponsor for this login."]);
        }
        $users = read_json("users.json");
        foreach ($users as $user) {
            if (($user["username"] ?? "") === $username) {
                send_json(400, ["error" => "That username is already used."]);
            }
        }
        $users[] = array_merge([
            "username" => $username,
            "role" => "sponsor",
            "organisationId" => $organisationId,
        ], hash_password($password));
        write_json("users.json", $users);
        log_activity(["action" => "create-user", "username" => $username, "organisationId" => $organisationId, "by" => $admin["username"]]);
        send_json(200, ["user" => ["username" => $username, "role" => "sponsor", "organisationId" => $organisationId]]);
    }

    if ($route === "backup" && $method === "GET") {
        $user = require_user();
        $orgs = read_json("organisations.json");
        $sites = read_json("sites.json");
        $scope = (string) ($_GET["scope"] ?? "sponsor");
        if ($scope === "full") {
            if (!is_admin($user)) {
                send_json(403, ["error" => "Only the site admin can download the whole catalogue."]);
            }
            $backup = [
                "version" => 1,
                "kind" => "full",
                "exportedAt" => gmdate("c"),
                "organisations" => $orgs,
                "sites" => $sites,
                "users" => read_json("users.json"),
                "settings" => read_settings(),
            ];
        } else {
            $organisationId = is_admin($user)
                ? (string) ($_GET["organisationId"] ?? ($orgs[0]["id"] ?? ""))
                : (string) ($user["organisationId"] ?? "");
            $org = find_org($orgs, $organisationId);
            if (!$org) {
                send_json(400, ["error" => "That sponsor is not in the catalogue."]);
            }
            $backup = [
                "version" => 1,
                "kind" => "sponsor",
                "organisationId" => $organisationId,
                "exportedAt" => gmdate("c"),
                "organisations" => [$org],
                "sites" => array_values(array_filter($sites, fn($site) => ($site["organisationId"] ?? "") === $organisationId)),
            ];
        }
        $backup["photos"] = collect_backup_photos($backup["sites"]);
        log_activity(["action" => "backup", "kind" => $backup["kind"], "by" => $user["username"]]);
        send_json(200, $backup);
    }

    if ($route === "restore" && $method === "POST") {
        $user = require_user();
        $backup = read_json_body();
        $next = apply_restore(read_json("organisations.json"), read_json("sites.json"), $backup, $user);
        write_json("organisations.json", $next["organisations"]);
        write_json("sites.json", $next["sites"]);
        if (($backup["kind"] ?? "") === "full" && is_admin($user) && isset($backup["users"]) && is_array($backup["users"])) {
            write_json("users.json", $backup["users"]);
        }
        if (($backup["kind"] ?? "") === "full" && is_admin($user) && isset($backup["settings"]) && is_array($backup["settings"])) {
            write_settings($backup["settings"]);
        }
        restore_photos($backup["photos"] ?? []);
        log_activity(["action" => "restore", "kind" => $backup["kind"] ?? "", "by" => $user["username"]]);
        send_json(200, [
            "organisations" => orgs_for_user($next["organisations"], $user),
            "sites" => sites_for_user($next["sites"], $user),
        ]);
    }

    if ($route === "organisations" && $method === "PUT") {
        $user = require_user();
        $incoming = read_json_body();
        if (!isset($incoming[0]) && $incoming !== []) {
            send_json(400, ["error" => "Expected a list of sponsors."]);
        }
        $current = read_json("organisations.json");
        if (!is_admin($user)) {
            $orgId = (string) ($user["organisationId"] ?? "");
            $edited = null;
            foreach ($incoming as $item) {
                if (($item["id"] ?? "") === $orgId) {
                    $edited = $item;
                    break;
                }
            }
            if (!$edited) {
                $edited = $incoming[0] ?? [];
            }
            $email = trim((string) ($edited["email"] ?? ""));
            if ($email === "") {
                send_json(400, ["error" => "Enter a public enquiry email address."]);
            }
            foreach ($current as $index => $org) {
                if (($org["id"] ?? "") === $orgId) {
                    $current[$index]["email"] = $email;
                }
            }
            write_json("organisations.json", $current);
            log_activity(["action" => "save-organisations", "by" => $user["username"]]);
            send_json(200, orgs_for_user($current, $user));
        }
        $next = [];
        foreach ($current as $org) {
            $edited = null;
            foreach ($incoming as $item) {
                if (($item["id"] ?? "") === ($org["id"] ?? "")) {
                    $edited = $item;
                    break;
                }
            }
            if (!$edited) {
                $next[] = $org;
                continue;
            }
            $email = trim((string) ($edited["email"] ?? $org["email"]));
            $name = trim((string) ($edited["name"] ?? $org["name"]));
            if ($name === "") {
                $name = $org["name"];
            }
            $subscribedAt = $edited["subscribedAt"] ?? $org["subscribedAt"];
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) $subscribedAt)) {
                $subscribedAt = $org["subscribedAt"];
            }
            $next[] = array_merge($org, [
                "email" => $email,
                "name" => $name,
                "subscribedAt" => $subscribedAt,
            ]);
        }
        foreach ($incoming as $item) {
            $id = trim((string) ($item["id"] ?? ""));
            $found = false;
            foreach ($next as $org) {
                if (($org["id"] ?? "") === $id) {
                    $found = true;
                    break;
                }
            }
            if ($found || $id === "") {
                continue;
            }
            $name = trim((string) ($item["name"] ?? ""));
            $email = trim((string) ($item["email"] ?? ""));
            if ($name === "" || $email === "") {
                send_json(400, ["error" => "A new sponsor needs a name and an email."]);
            }
            $max = 0;
            foreach ($next as $org) {
                $max = max($max, (int) ($org["number"] ?? 0));
            }
            $next[] = [
                "number" => $max + 1,
                "id" => $id,
                "name" => $name,
                "type" => $item["type"] ?? "Organisation",
                "email" => $email,
                "subscribedAt" => preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) ($item["subscribedAt"] ?? "")) ? $item["subscribedAt"] : gmdate("Y-m-d"),
                "createdAt" => preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) ($item["createdAt"] ?? "")) ? $item["createdAt"] : gmdate("Y-m-d"),
            ];
        }
        write_json("organisations.json", $next);
        log_activity(["action" => "save-organisations", "by" => $user["username"]]);
        send_json(200, $next);
    }

    if ($route === "sites" && $method === "PUT") {
        $user = require_user();
        $incoming = read_json_body();
        if (!isset($incoming[0]) && $incoming !== []) {
            send_json(400, ["error" => "Expected a list of sites."]);
        }
        $current = read_json("sites.json");
        if (is_admin($user)) {
            $next = $incoming;
        } else {
            $orgId = (string) ($user["organisationId"] ?? "");
            foreach ($incoming as $site) {
                if (($site["organisationId"] ?? "") !== $orgId) {
                    send_json(403, ["error" => "You can only save your own sites."]);
                }
            }
            $next = array_merge(
                array_values(array_filter($current, fn($site) => ($site["organisationId"] ?? "") !== $orgId)),
                $incoming
            );
        }
        write_json("sites.json", $next);
        log_activity(["action" => "save-sites", "by" => $user["username"]]);
        send_json(200, sites_for_user($next, $user));
    }

    if ($route === "media" && $method === "POST") {
        $user = require_user();
        $orgs = read_json("organisations.json");
        $sponsor = (int) ($_GET["sponsor"] ?? 0);
        $org = null;
        foreach ($orgs as $item) {
            if ((int) ($item["number"] ?? 0) === $sponsor) {
                $org = $item;
                break;
            }
        }
        if (!$org) {
            send_json(400, ["error" => "Unknown sponsor number."]);
        }
        if (!is_admin($user) && ($org["id"] ?? "") !== ($user["organisationId"] ?? "")) {
            send_json(403, ["error" => "You can only add photographs for your own sites."]);
        }
        $codes = collect_codes(read_json("sites.json"));
        $requested = parse_photo_code((string) ($_GET["code"] ?? ""));
        $code = ($requested && $requested["sponsorNumber"] === $sponsor)
            ? $sponsor . "-" . str_pad((string) $requested["reference"], 3, "0", STR_PAD_LEFT)
            : next_photo_code($sponsor, $codes);
        $buffer = read_body();
        if (strlen($buffer) < 3 || ord($buffer[0]) !== 0xFF || ord($buffer[1]) !== 0xD8) {
            send_json(400, ["error" => "Save the photograph as a JPEG."]);
        }
        if (!is_dir($imageDir)) {
            mkdir($imageDir, 0755, true);
        }
        file_put_contents($imageDir . DIRECTORY_SEPARATOR . $code . ".jpg", $buffer);
        log_activity(["action" => "save-photo", "code" => $code, "by" => $user["username"]]);
        send_json(200, ["code" => $code, "url" => "images/{$code}.jpg"]);
    }

    send_json(404, ["error" => "Not found."]);
} catch (Throwable $error) {
    send_json(500, ["error" => "The server could not finish that."]);
}
