<?php
declare(strict_types=1);

header("Cache-Control: no-store");
header("Content-Type: application/json; charset=utf-8");

$root = __DIR__;
$dataDir = $root . DIRECTORY_SEPARATOR . "data";
$imageDir = $root . DIRECTORY_SEPARATOR . "images";
$route = (string) ($_GET["r"] ?? "");
$method = $_SERVER["REQUEST_METHOD"] ?? "GET";

$https = (!empty($_SERVER["HTTPS"]) && $_SERVER["HTTPS"] !== "off")
    || (isset($_SERVER["HTTP_X_FORWARDED_PROTO"]) && $_SERVER["HTTP_X_FORWARDED_PROTO"] === "https");
session_set_cookie_params([
    "lifetime" => 12 * 3600,
    "path" => "/",
    "httponly" => true,
    "samesite" => "Lax",
    "secure" => $https,
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

function clean_category_list($list, array $fallback): array {
    $seen = [];
    $names = [];
    if (!is_array($list)) {
        $list = [];
    }
    foreach ($list as $item) {
        $name = trim((string) $item);
        if ($name === "") {
            continue;
        }
        if (strlen($name) > 40) {
            $name = substr($name, 0, 40);
        }
        $key = strtolower($name);
        if (isset($seen[$key])) {
            continue;
        }
        $seen[$key] = true;
        $names[] = $name;
    }
    if (!$names) {
        $names = $fallback;
    }
    natcasesort($names);
    return array_values($names);
}

function read_settings(): array {
    $defaultsHeritage = ["Civic", "Industrial", "Recreation", "Transport"];
    $defaultsShop = ["Restaurants", "Shops"];
    $defaultsExhibit = ["Collectibles", "Industrial", "Transport", "Uncategorised"];
    $path = data_path("settings.json");
    if (!is_readable($path)) {
        return ["sponsorNotice" => "", "heritageCategories" => $defaultsHeritage, "shopCategories" => $defaultsShop, "exhibitCategories" => $defaultsExhibit];
    }
    $decoded = json_decode((string) file_get_contents($path), true);
    $notice = is_array($decoded) ? trim((string) ($decoded["sponsorNotice"] ?? "")) : "";
    if (strlen($notice) > 400) {
        $notice = substr($notice, 0, 400);
    }
    return [
        "sponsorNotice" => $notice,
        "heritageCategories" => clean_category_list(is_array($decoded) ? ($decoded["heritageCategories"] ?? []) : [], $defaultsHeritage),
        "shopCategories" => clean_category_list(is_array($decoded) ? ($decoded["shopCategories"] ?? []) : [], $defaultsShop),
        "exhibitCategories" => clean_category_list(is_array($decoded) ? ($decoded["exhibitCategories"] ?? []) : [], $defaultsExhibit),
    ];
}

function normalise_org_kind(string $kind, string $fallback = "site"): string {
    $value = strtolower(trim($kind));
    if ($value === "shop" || $value === "site" || $value === "exhibit") {
        return $value;
    }
    $fb = strtolower(trim($fallback));
    if ($fb === "shop" || $fb === "site" || $fb === "exhibit") {
        return $fb;
    }
    return "site";
}

function write_settings(array $value): array {
    $current = read_settings();
    $notice = array_key_exists("sponsorNotice", $value) ? trim((string) ($value["sponsorNotice"] ?? "")) : $current["sponsorNotice"];
    if (strlen($notice) > 400) {
        $notice = substr($notice, 0, 400);
    }
    $heritage = isset($value["heritageCategories"]) ? clean_category_list($value["heritageCategories"], $current["heritageCategories"]) : $current["heritageCategories"];
    $shop = isset($value["shopCategories"]) ? clean_category_list($value["shopCategories"], $current["shopCategories"]) : $current["shopCategories"];
    $exhibit = isset($value["exhibitCategories"]) ? clean_category_list($value["exhibitCategories"], $current["exhibitCategories"]) : $current["exhibitCategories"];
    $settings = ["sponsorNotice" => $notice, "heritageCategories" => $heritage, "shopCategories" => $shop, "exhibitCategories" => $exhibit];
    write_json("settings.json", $settings);
    write_json("categories.json", ["heritage" => $heritage, "shop" => $shop, "exhibit" => $exhibit]);
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

function extra_months($org): int {
    $n = (int) ($org["extraMonths"] ?? 0);
    if ($n < 0) {
        return 0;
    }
    return min($n, 120);
}

function subscription_state(string $start, int $extraMonths = 0): string {
    $from = DateTime::createFromFormat("Y-m-d", $start);
    if (!$from) {
        return "lapsed";
    }
    $extra = max(0, $extraMonths);
    $today = new DateTime("today");
    $grace = (clone $from)->modify("+" . (12 + $extra) . " months");
    $lapse = (clone $from)->modify("+" . (13 + $extra) . " months");
    if ($today >= $lapse) {
        return "lapsed";
    }
    if ($today >= $grace) {
        return "grace";
    }
    return "active";
}

function is_listed(array $site, array $org): bool {
    $extra = extra_months($org);
    return subscription_state((string) ($org["subscribedAt"] ?? ""), $extra) !== "lapsed"
        && subscription_state((string) ($site["createdAt"] ?? ""), $extra) !== "lapsed";
}

function format_generic_code(int $number): ?array {
    if ($number < 1 || $number > 999999) {
        return null;
    }
    $digits = str_pad((string) $number, 4, "0", STR_PAD_LEFT);
    return [
        "number" => $number,
        "digits" => $digits,
        "label" => "Generic{$digits}",
        "listingId" => "generic{$digits}",
    ];
}

function parse_generic_code(string $value): ?array {
    if (!preg_match('/generic\s*0*(\d{1,6})/i', $value, $match)) {
        return null;
    }
    return format_generic_code((int) $match[1]);
}

function used_generic_numbers(array $sites, array $organisations = []): array {
    $nums = [];
    foreach ($sites as $site) {
        $parsed = parse_generic_code((string) ($site["id"] ?? "")) ?: parse_generic_code((string) ($site["genericCode"] ?? ""));
        if ($parsed) {
            $nums[$parsed["number"]] = true;
        }
    }
    foreach ($organisations as $org) {
        $parsed = parse_generic_code((string) ($org["referralCode"] ?? "")) ?: parse_generic_code((string) ($org["id"] ?? ""));
        if ($parsed) {
            $nums[$parsed["number"]] = true;
        }
    }
    return array_keys($nums);
}

function generic_listing_taken(array $sites, array $organisations, ?array $generic): bool {
    if (!$generic) {
        return true;
    }
    $listingId = $generic["listingId"];
    foreach ($sites as $site) {
        if (($site["id"] ?? "") === $listingId) {
            return true;
        }
    }
    foreach ($organisations as $org) {
        if (($org["id"] ?? "") === $listingId) {
            return true;
        }
        $referral = parse_generic_code((string) ($org["referralCode"] ?? ""));
        if ($referral && ($referral["listingId"] ?? "") === $listingId) {
            return true;
        }
    }
    return false;
}

function generic_labels_for_sponsor(array $sites, array $organisations, string $organisationId): array {
    $labels = [];
    $org = find_org($organisations, $organisationId);
    foreach ($sites as $site) {
        if (($site["organisationId"] ?? "") !== $organisationId) {
            continue;
        }
        foreach ([$site["id"] ?? "", $site["genericCode"] ?? ""] as $raw) {
            $parsed = parse_generic_code((string) $raw);
            if ($parsed) {
                $labels[$parsed["label"]] = true;
            }
        }
    }
    foreach ([$org["id"] ?? "", $org["referralCode"] ?? ""] as $raw) {
        $parsed = parse_generic_code((string) $raw);
        if ($parsed) {
            $labels[$parsed["label"]] = true;
        }
    }
    return array_keys($labels);
}

function next_generic_code(array $sites, array $organisations = []): array {
    $max = 0;
    foreach (used_generic_numbers($sites, $organisations) as $number) {
        $max = max($max, (int) $number);
    }
    return format_generic_code($max + 1);
}

function slugify_id(string $value): string {
    $slug = strtolower(trim($value));
    $slug = preg_replace('/[^a-z0-9]+/', "-", $slug) ?? "";
    $slug = trim($slug, "-");
    return substr($slug, 0, 80);
}

function org_logo_stem(array $org): string {
    $slug = slugify_id((string) ($org["id"] ?? ""));
    if ($slug === "") {
        $slug = "sponsor-" . max(1, (int) ($org["number"] ?? 0));
    }
    return $slug . "-club-logo";
}

function delete_org_logo_files(array $org): void {
    global $imageDir;
    if (!is_dir($imageDir)) {
        return;
    }
    $stem = org_logo_stem($org);
    foreach (["jpg", "jpeg", "png", "webp", "gif"] as $ext) {
        $path = $imageDir . DIRECTORY_SEPARATOR . $stem . "." . $ext;
        if (is_file($path)) {
            @unlink($path);
        }
    }
    $n = (int) ($org["number"] ?? 0);
    if ($n > 0) {
        foreach (["jpg", "jpeg", "png", "webp", "gif"] as $ext) {
            $legacy = $imageDir . DIRECTORY_SEPARATOR . "logo-{$n}.{$ext}";
            if (is_file($legacy)) {
                @unlink($legacy);
            }
        }
    }
    $url = explode("?", (string) ($org["logoUrl"] ?? ""))[0];
    if ($url !== "" && str_starts_with($url, "images/")) {
        $file = $imageDir . DIRECTORY_SEPARATOR . basename($url);
        if (is_file($file)) {
            @unlink($file);
        }
    }
}

function listing_kind_from_type(string $type): ?array {
    $value = strtolower(trim($type));
    if ($value === "shop" || $value === "shops") {
        return ["kind" => "shop", "shopGroup" => "shops", "type" => "Shop", "category" => "Shops"];
    }
    if ($value === "restaurant" || $value === "restaurants") {
        return ["kind" => "shop", "shopGroup" => "restaurants", "type" => "Restaurant", "category" => "Restaurants"];
    }
    if ($value === "site" || $value === "sites") {
        return ["kind" => "site", "shopGroup" => "", "type" => "Organisation", "category" => "Uncategorised"];
    }
    return null;
}

function find_referrer(array $orgs, array $sites, array $users, string $query): ?array {
    $raw = trim($query);
    if ($raw === "") {
        return null;
    }
    $generic = parse_generic_code($raw);
    if ($generic) {
        foreach ($sites as $site) {
            if (($site["id"] ?? "") === $generic["listingId"]) {
                return find_org($orgs, (string) ($site["organisationId"] ?? ""));
            }
        }
        foreach ($orgs as $org) {
            if (($org["referralCode"] ?? "") === $generic["label"] || ($org["id"] ?? "") === $generic["listingId"]) {
                return $org;
            }
        }
        return null;
    }
    $login = strtolower($raw);
    foreach ($users as $user) {
        if (($user["username"] ?? "") === $login && !empty($user["organisationId"])) {
            return find_org($orgs, (string) $user["organisationId"]);
        }
    }
    $matches = [];
    foreach ($orgs as $org) {
        if (($org["id"] ?? "") === $raw || strtolower((string) ($org["name"] ?? "")) === $login) {
            $matches[] = $org;
        }
    }
    return count($matches) === 1 ? $matches[0] : null;
}

function format_day_iso(string $iso): string {
    $dt = DateTime::createFromFormat("Y-m-d", $iso);
    return $dt ? $dt->format("j M Y") : $iso;
}

function add_months_iso(string $iso, int $months): string {
    $from = DateTime::createFromFormat("Y-m-d", $iso);
    if (!$from) {
        return $iso;
    }
    $day = (int) $from->format("j");
    $from->modify("first day of this month");
    $from->modify("+" . $months . " months");
    $last = (int) $from->format("t");
    $from->setDate((int) $from->format("Y"), (int) $from->format("n"), min($day, $last));
    return $from->format("Y-m-d");
}

function welcome_email(array $info): array {
    $first = $info["contactName"] !== "" ? $info["contactName"] : "there";
    $business = $info["businessName"];
    $kindWord = $info["listingKind"];
    $publicUntil = add_months_iso($info["subscribedAt"], 12 + (int) $info["extraMonths"]);
    $graceUntil = add_months_iso($info["subscribedAt"], 13 + (int) $info["extraMonths"]);
    $loginUrl = "https://touristqr.com/admin.html";
    $subject = "Welcome to TouristQR — {$business}";
    $text = "Hello {$first},\n\n{$business} is now listed on TouristQR as a {$kindWord}.\n\nYour public page (tap or scan this QR code):\n{$info["publicUrl"]}\n\nSign in to add photos, edit the wording, and keep the listing up to date:\n{$loginUrl}\nLogin name: {$info["username"]}\nLogin password: {$info["password"]}\nYou can change the password after you sign in.\n\nSponsorship started " . format_day_iso($info["subscribedAt"]) . ".\nThe listing stays on the public site until " . format_day_iso($publicUntil) . ", then has one extra grace month (until " . format_day_iso($graceUntil) . ") before it is archived.\n\nReferral offer: for every new business that names you when they sign up, you receive 1 extra month of public listing.\nThey can give us your code {$info["genericLabel"]} or your login name {$info["username"]}.\n\nTouristQR\nhttps://touristqr.com/\n";
    $html = "<p>Hello " . htmlspecialchars($first) . ",</p>"
        . "<p><strong>" . htmlspecialchars($business) . "</strong> is now listed on TouristQR as a " . htmlspecialchars($kindWord) . ".</p>"
        . "<p>Your public page — tap the QR code or open this link:<br><a href=\"" . htmlspecialchars($info["publicUrl"]) . "\">" . htmlspecialchars($info["publicUrl"]) . "</a></p>"
        . "<p><a href=\"" . htmlspecialchars($info["publicUrl"]) . "\"><img src=\"cid:qr@touristqr.com\" alt=\"QR code for " . htmlspecialchars($info["genericLabel"]) . "\" width=\"220\" height=\"220\" style=\"width:220px;height:220px;border:0;\"></a></p>"
        . "<p>Sign in to add photographs, edit the wording, and keep the listing up to date:<br><a href=\"{$loginUrl}\">{$loginUrl}</a><br>Login name: <strong>" . htmlspecialchars($info["username"]) . "</strong><br>Login password: <strong>" . htmlspecialchars($info["password"]) . "</strong><br>You can change the password after you sign in.</p>"
        . "<p>Sponsorship started " . htmlspecialchars(format_day_iso($info["subscribedAt"])) . ". The listing stays on the public site until <strong>" . htmlspecialchars(format_day_iso($publicUntil)) . "</strong>, then has one extra grace month (until " . htmlspecialchars(format_day_iso($graceUntil)) . ") before it is archived.</p>"
        . "<p><strong>Referral offer:</strong> for every new business that names you when they sign up, you receive 1 extra month of public listing. They can give us your code <strong>" . htmlspecialchars($info["genericLabel"]) . "</strong> or your login name <strong>" . htmlspecialchars($info["username"]) . "</strong>.</p>"
        . "<p>TouristQR<br><a href=\"https://touristqr.com/\">https://touristqr.com/</a></p>";
    return ["subject" => $subject, "text" => $text, "html" => $html];
}

function detect_image_upload(string $binary): ?array {
    $len = strlen($binary);
    if ($len >= 3 && ord($binary[0]) === 0xFF && ord($binary[1]) === 0xD8) {
        return ["ext" => "jpg", "mime" => "image/jpeg"];
    }
    if ($len >= 8 && ord($binary[0]) === 0x89 && ord($binary[1]) === 0x50) {
        return ["ext" => "png", "mime" => "image/png"];
    }
    if ($len >= 6 && (substr($binary, 0, 6) === "GIF87a" || substr($binary, 0, 6) === "GIF89a")) {
        return ["ext" => "gif", "mime" => "image/gif"];
    }
    if ($len >= 12 && substr($binary, 0, 4) === "RIFF" && substr($binary, 8, 4) === "WEBP") {
        return ["ext" => "webp", "mime" => "image/webp"];
    }
    return null;
}

function image_from_payload(string $raw): array {
    $text = trim($raw);
    if (preg_match('/^data:image\/(\w+);base64,(.+)$/i', $text, $match)) {
        $binary = base64_decode($match[2], true);
    } elseif (strpos($text, "data:") !== 0) {
        $binary = base64_decode(preg_replace('/\s+/', "", $text) ?? "", true);
    } else {
        $binary = false;
    }
    if ($binary === false || strlen($binary) > 1600000) {
        send_json(400, ["error" => "Use JPEG, PNG, GIF, or WebP."]);
    }
    $detected = detect_image_upload($binary);
    if (!$detected) {
        send_json(400, ["error" => "Use JPEG, PNG, GIF, or WebP."]);
    }
    return ["binary" => $binary, "ext" => $detected["ext"]];
}

function png_from_payload(string $raw): ?string {
    if (!preg_match('/^data:image\/png;base64,(.+)$/i', trim($raw), $match)) {
        return null;
    }
    $binary = base64_decode($match[1], true);
    if ($binary === false || strlen($binary) < 8 || ord($binary[0]) !== 0x89) {
        return null;
    }
    return $binary;
}

function send_signup_mail(array $email, string $to, ?string $png): array {
    $boundary = "mix_" . bin2hex(random_bytes(8));
    $alt = "alt_" . bin2hex(random_bytes(8));
    $headers = implode("\r\n", [
        "From: TouristQR <web@touristqr.com>",
        "MIME-Version: 1.0",
        "Content-Type: multipart/mixed; boundary=\"{$boundary}\"",
    ]);
    $body = "--{$boundary}\r\nContent-Type: multipart/alternative; boundary=\"{$alt}\"\r\n\r\n";
    $body .= "--{$alt}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n";
    $body .= $email["text"] . "\r\n\r\n";
    $body .= "--{$alt}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n";
    $body .= $email["html"] . "\r\n\r\n--{$alt}--\r\n";
    if ($png) {
        $body .= "--{$boundary}\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\n";
        $body .= "Content-ID: <qr@touristqr.com>\r\nContent-Disposition: inline; filename=\"listing-qr.png\"\r\n\r\n";
        $body .= chunk_split(base64_encode($png)) . "\r\n";
    }
    $body .= "--{$boundary}--\r\n";
    $encodedSubject = "=?UTF-8?B?" . base64_encode($email["subject"]) . "?=";
    $ok = @mail($to, $encodedSubject, $body, $headers, "-fweb@touristqr.com");
    return $ok
        ? ["sent" => true, "note" => ""]
        : ["sent" => false, "note" => "Saved, but the welcome email could not be sent."];
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

function delete_photo_files_for_sites(array $sites): void {
    global $imageDir;
    $exts = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
    foreach ($sites as $site) {
        foreach ($site["photos"] ?? [] as $photo) {
            $code = trim((string) ($photo["code"] ?? ""));
            if ($code === "") {
                continue;
            }
            $url = trim((string) ($photo["url"] ?? ""));
            if (str_starts_with($url, "data:")) {
                continue;
            }
            $relative = preg_replace('/^images\//i', "", $url);
            if ($relative !== "") {
                $filePath = $imageDir . DIRECTORY_SEPARATOR . str_replace("/", DIRECTORY_SEPARATOR, $relative);
                if (is_file($filePath)) {
                    @unlink($filePath);
                    continue;
                }
            }
            foreach ($exts as $ext) {
                $alt = $imageDir . DIRECTORY_SEPARATOR . $code . $ext;
                if (is_file($alt)) {
                    @unlink($alt);
                    break;
                }
            }
        }
    }
}

function stamp_photo_media_version(string $code, string $url): int {
    $version = (int) floor(microtime(true) * 1000);
    $sites = read_json("sites.json");
    $changed = false;
    foreach ($sites as $i => $site) {
        $siteChanged = false;
        foreach ($site["photos"] ?? [] as $j => $photo) {
            if (($photo["code"] ?? "") !== $code) {
                continue;
            }
            $sites[$i]["photos"][$j]["url"] = $url;
            $sites[$i]["photos"][$j]["mediaVersion"] = $version;
            $siteChanged = true;
        }
        if ($siteChanged) {
            $sites[$i]["updatedAt"] = gmdate("c");
            $changed = true;
        }
    }
    if ($changed) {
        write_json("sites.json", $sites);
    }
    return $version;
}

function delete_photo_files_for_sponsor_number(int $sponsorNumber): void {
    global $imageDir;
    if ($sponsorNumber < 1 || !is_dir($imageDir)) {
        return;
    }
    $prefix = $sponsorNumber . "-";
    foreach (scandir($imageDir) ?: [] as $name) {
        if ($name === "." || $name === "..") {
            continue;
        }
        if (!str_starts_with(strtolower($name), strtolower($prefix))) {
            continue;
        }
        $code = preg_replace('/\.(jpe?g|png|gif|webp)$/i', "", $name);
        if (!parse_photo_code((string) $code)) {
            continue;
        }
        @unlink($imageDir . DIRECTORY_SEPARATOR . $name);
    }
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
                "contactName" => $incomingOrg["contactName"] ?? $org["contactName"] ?? "",
                "contactEmail" => $incomingOrg["contactEmail"] ?? $org["contactEmail"] ?? "",
                "extraMonths" => $incomingOrg["extraMonths"] ?? $org["extraMonths"] ?? 0,
                "referredBy" => $incomingOrg["referredBy"] ?? $org["referredBy"] ?? "",
                "referralCode" => $incomingOrg["referralCode"] ?? $org["referralCode"] ?? "",
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
                "state" => subscription_state((string) ($org["subscribedAt"] ?? ""), extra_months($org)),
                "siteCount" => count($mine),
                "publicCount" => count($public),
            ];
        }
        send_json(200, $rows);
    }

    if ($route === "users" && $method === "GET") {
        $user = require_user();
        $organisationId = trim((string) ($_GET["organisationId"] ?? ""));
        if ($organisationId === "") {
            send_json(400, ["error" => "Choose a sponsor."]);
        }
        if (!is_admin($user) && (string) ($user["organisationId"] ?? "") !== $organisationId) {
            send_json(403, ["error" => "You can only view your own login."]);
        }
        $username = "";
        foreach (read_json("users.json") as $item) {
            if (($item["role"] ?? "") === "sponsor" && ($item["organisationId"] ?? "") === $organisationId) {
                $username = (string) ($item["username"] ?? "");
                break;
            }
        }
        send_json(200, ["username" => $username]);
    }

    if ($route === "users" && $method === "PUT") {
        $user = require_user();
        $body = read_json_body();
        $organisationId = trim((string) ($body["organisationId"] ?? ""));
        $username = strtolower(trim((string) ($body["username"] ?? "")));
        $password = (string) ($body["password"] ?? "");
        if ($organisationId === "") {
            send_json(400, ["error" => "Choose a sponsor."]);
        }
        if (!is_admin($user) && (string) ($user["organisationId"] ?? "") !== $organisationId) {
            send_json(403, ["error" => "You can only change your own login."]);
        }
        if (!find_org(read_json("organisations.json"), $organisationId)) {
            send_json(400, ["error" => "Choose a sponsor for this login."]);
        }
        $users = read_json("users.json");
        $index = -1;
        foreach ($users as $i => $item) {
            if (($item["role"] ?? "") === "sponsor" && ($item["organisationId"] ?? "") === $organisationId) {
                $index = $i;
                break;
            }
        }
        if ($index < 0) {
            if (!preg_match('/^[a-z0-9._-]{3,40}$/', $username) || strlen($password) < 8) {
                send_json(400, ["error" => "A new login needs a login name and a password of at least 8 characters."]);
            }
            foreach ($users as $item) {
                if (($item["username"] ?? "") === $username) {
                    send_json(400, ["error" => "That login name is already used."]);
                }
            }
            $users[] = array_merge([
                "username" => $username,
                "role" => "sponsor",
                "organisationId" => $organisationId,
            ], hash_password($password));
            write_json("users.json", $users);
            log_activity(["action" => "create-user", "username" => $username, "organisationId" => $organisationId, "by" => $user["username"]]);
            send_json(200, ["username" => $username]);
        }
        if ($username !== "" && !preg_match('/^[a-z0-9._-]{3,40}$/', $username)) {
            send_json(400, ["error" => "A login name uses 3–40 letters, numbers, dots, hyphens, or underscores."]);
        }
        if ($username !== "") {
            foreach ($users as $i => $item) {
                if (($item["username"] ?? "") === $username && $i !== $index) {
                    send_json(400, ["error" => "That login name is already used."]);
                }
            }
        }
        if ($password !== "" && strlen($password) < 8) {
            send_json(400, ["error" => "A new password needs at least 8 characters."]);
        }
        $previous = (string) ($users[$index]["username"] ?? "");
        $nextName = $username !== "" ? $username : $previous;
        if ($username === "" && $password === "") {
            send_json(200, ["username" => $previous]);
        }
        $users[$index]["username"] = $nextName;
        if ($password !== "") {
            $users[$index] = array_merge($users[$index], hash_password($password));
        }
        write_json("users.json", $users);
        if ($previous !== $nextName && ($user["username"] ?? "") === $previous) {
            $_SESSION["username"] = $nextName;
        }
        log_activity(["action" => "update-user", "username" => $nextName, "organisationId" => $organisationId, "by" => $user["username"]]);
        send_json(200, ["username" => $nextName]);
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
            $contactName = substr(trim((string) ($edited["contactName"] ?? "")), 0, 80);
            $contactEmail = substr(trim((string) ($edited["contactEmail"] ?? "")), 0, 120);
            $name = trim((string) ($edited["name"] ?? ""));
            $kind = "site";
            foreach ($current as $org) {
                if (($org["id"] ?? "") === $orgId) {
                    $kind = normalise_org_kind((string) ($org["kind"] ?? "site"));
                    if ($name === "") {
                        $name = (string) ($org["name"] ?? "");
                    }
                    break;
                }
            }
            if ($kind !== "shop" && $email === "") {
                send_json(400, ["error" => "Enter a public contact email address."]);
            }
            foreach ($current as $index => $org) {
                if (($org["id"] ?? "") === $orgId) {
                    $current[$index]["email"] = $email;
                    $current[$index]["contactName"] = $contactName;
                    $current[$index]["contactEmail"] = $contactEmail;
                    $current[$index]["website"] = substr(trim((string) ($edited["website"] ?? $org["website"] ?? "")), 0, 200);
                    if ($name !== "") {
                        $current[$index]["name"] = $name;
                    }
                    if ($kind === "shop") {
                        $current[$index]["shopGroup"] = (($edited["shopGroup"] ?? $org["shopGroup"] ?? "shops") === "restaurants") ? "restaurants" : "shops";
                    }
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
            $kind = normalise_org_kind((string) ($org["kind"] ?? "site"));
            $shopGroup = $kind === "shop"
                ? ((($edited["shopGroup"] ?? $org["shopGroup"] ?? "shops") === "restaurants") ? "restaurants" : "shops")
                : "";
            $merged = array_merge($org, [
                "email" => $email,
                "contactName" => substr(trim((string) ($edited["contactName"] ?? $org["contactName"] ?? "")), 0, 80),
                "contactEmail" => substr(trim((string) ($edited["contactEmail"] ?? $org["contactEmail"] ?? "")), 0, 120),
                "website" => substr(trim((string) ($edited["website"] ?? $org["website"] ?? "")), 0, 200),
                "name" => $name,
                "subscribedAt" => $subscribedAt,
                "kind" => $kind,
            ]);
            if ($kind === "shop") {
                $merged["shopGroup"] = $shopGroup;
            } else {
                unset($merged["shopGroup"]);
            }
            $next[] = $merged;
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
            $kind = normalise_org_kind((string) ($item["kind"] ?? "site"));
            if ($name === "" || ($kind !== "shop" && $email === "")) {
                send_json(400, ["error" => $kind === "shop" ? "A new shop sponsor needs a name." : "A new sponsor needs a name and an email."]);
            }
            $max = 0;
            foreach ($next as $org) {
                $max = max($max, (int) ($org["number"] ?? 0));
            }
            $shopGroup = $kind === "shop"
                ? ((($item["shopGroup"] ?? "shops") === "restaurants") ? "restaurants" : "shops")
                : "";
            $newOrg = [
                "number" => $max + 1,
                "id" => $id,
                "name" => $name,
                "type" => $item["type"] ?? ($kind === "shop" ? "Shop" : ($kind === "exhibit" ? "Exhibit" : "Organisation")),
                "kind" => $kind,
                "email" => $email,
                "contactName" => substr(trim((string) ($item["contactName"] ?? "")), 0, 80),
                "contactEmail" => substr(trim((string) ($item["contactEmail"] ?? "")), 0, 120),
                "subscribedAt" => preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) ($item["subscribedAt"] ?? "")) ? $item["subscribedAt"] : gmdate("Y-m-d"),
                "createdAt" => preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) ($item["createdAt"] ?? "")) ? $item["createdAt"] : gmdate("Y-m-d"),
            ];
            if ($kind === "shop") {
                $newOrg["shopGroup"] = $shopGroup;
            }
            $next[] = $newOrg;
        }
        write_json("organisations.json", $next);
        log_activity(["action" => "save-organisations", "by" => $user["username"]]);
        send_json(200, $next);
    }

    if ($route === "delete-sponsor" && $method === "POST") {
        $admin = require_admin();
        $body = read_json_body();
        $organisationId = trim((string) ($body["organisationId"] ?? ""));
        $orgs = read_json("organisations.json");
        $org = find_org($orgs, $organisationId);
        if (!$org) {
            send_json(400, ["error" => "Choose a sponsor to delete."]);
        }
        $sites = read_json("sites.json");
        $releasedGenerics = generic_labels_for_sponsor($sites, $orgs, $organisationId);
        $removed = array_values(array_filter($sites, fn($site) => ($site["organisationId"] ?? "") === $organisationId));
        delete_photo_files_for_sites($removed);
        delete_photo_files_for_sponsor_number((int) ($org["number"] ?? 0));
        delete_org_logo_files($org);
        $orgs = array_values(array_filter($orgs, fn($item) => ($item["id"] ?? "") !== $organisationId));
        $sites = array_values(array_filter($sites, fn($site) => ($site["organisationId"] ?? "") !== $organisationId));
        $users = array_values(array_filter(read_json("users.json"), fn($item) => !(($item["role"] ?? "") === "sponsor" && ($item["organisationId"] ?? "") === $organisationId)));
        write_json("organisations.json", $orgs);
        write_json("sites.json", $sites);
        write_json("users.json", $users);
        log_activity([
            "action" => "delete-sponsor",
            "organisationId" => $organisationId,
            "deleteListings" => true,
            "releasedGenerics" => $releasedGenerics,
            "by" => $admin["username"],
        ]);
        send_json(200, ["organisations" => $orgs, "sites" => $sites, "releasedGenerics" => $releasedGenerics]);
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

    if ($route === "org-logo" && ($method === "POST" || $method === "DELETE")) {
        $user = require_user();
        $orgs = read_json("organisations.json");
        $sponsor = (int) ($_GET["sponsor"] ?? 0);
        $org = null;
        $orgIndex = null;
        foreach ($orgs as $index => $item) {
            if ((int) ($item["number"] ?? 0) === $sponsor) {
                $org = $item;
                $orgIndex = $index;
                break;
            }
        }
        if (!$org || $orgIndex === null) {
            send_json(400, ["error" => "Unknown sponsor number."]);
        }
        if ((($org["kind"] ?? "site") !== "exhibit")) {
            send_json(400, ["error" => "Club logos are only for exhibit sponsors."]);
        }
        if (!is_admin($user) && ($org["id"] ?? "") !== ($user["organisationId"] ?? "")) {
            send_json(403, ["error" => "You can only change your own sponsor logo."]);
        }
        if ($method === "DELETE") {
            delete_org_logo_files($org);
            unset($orgs[$orgIndex]["logoUrl"], $orgs[$orgIndex]["logoVersion"]);
            write_json("organisations.json", $orgs);
            log_activity(["action" => "remove-org-logo", "sponsor" => $sponsor, "by" => $user["username"]]);
            send_json(200, ["logoUrl" => "", "logoVersion" => null]);
        }
        $buffer = read_body();
        $detected = detect_image_upload($buffer);
        if (!$detected) {
            send_json(400, ["error" => "Use JPEG, PNG, GIF, or WebP."]);
        }
        if (!is_dir($imageDir)) {
            mkdir($imageDir, 0755, true);
        }
        delete_org_logo_files($org);
        $ext = $detected["ext"];
        $stem = org_logo_stem($org);
        $relativeUrl = "images/{$stem}.{$ext}";
        file_put_contents($imageDir . DIRECTORY_SEPARATOR . $stem . "." . $ext, $buffer);
        $logoVersion = (int) round(microtime(true) * 1000);
        $orgs[$orgIndex]["logoUrl"] = $relativeUrl;
        $orgs[$orgIndex]["logoVersion"] = $logoVersion;
        write_json("organisations.json", $orgs);
        log_activity(["action" => "save-org-logo", "sponsor" => $sponsor, "by" => $user["username"]]);
        send_json(200, ["logoUrl" => $relativeUrl, "logoVersion" => $logoVersion]);
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
        $detected = detect_image_upload($buffer);
        if (!$detected) {
            send_json(400, ["error" => "Use JPEG, PNG, GIF, or WebP."]);
        }
        if (!is_dir($imageDir)) {
            mkdir($imageDir, 0755, true);
        }
        $ext = $detected["ext"];
        $relativeUrl = "images/{$code}.{$ext}";
        file_put_contents($imageDir . DIRECTORY_SEPARATOR . $code . "." . $ext, $buffer);
        $mediaVersion = stamp_photo_media_version($code, $relativeUrl);
        log_activity(["action" => "save-photo", "code" => $code, "mediaVersion" => $mediaVersion, "by" => $user["username"]]);
        send_json(200, ["code" => $code, "url" => $relativeUrl, "mediaVersion" => $mediaVersion]);
    }

    if ($route === "signup-meta" && $method === "GET") {
        require_admin();
        send_json(200, ["next" => next_generic_code(read_json("sites.json"), read_json("organisations.json"))]);
    }

    if ($route === "signup" && $method === "POST") {
        $admin = require_admin();
        $body = read_json_body();
        $listing = listing_kind_from_type((string) ($body["type"] ?? ""));
        if (!$listing) {
            send_json(400, ["error" => "Choose Site, Shop, or Restaurant."]);
        }
        $name = trim((string) ($body["businessName"] ?? $body["name"] ?? ""));
        if ($name === "") {
            send_json(400, ["error" => "Enter the business name."]);
        }
        $contactName = substr(trim((string) ($body["contactName"] ?? "")), 0, 80);
        if ($contactName === "") {
            send_json(400, ["error" => "Enter the contact name."]);
        }
        $contactEmail = substr(trim((string) ($body["contactEmail"] ?? "")), 0, 120);
        if (!preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $contactEmail)) {
            send_json(400, ["error" => "Enter the contact email address."]);
        }
        $username = strtolower(trim((string) ($body["username"] ?? $body["loginName"] ?? "")));
        if (!preg_match('/^[a-z0-9._-]{3,40}$/', $username)) {
            send_json(400, ["error" => "A login name uses 3–40 letters, numbers, dots, hyphens, or underscores."]);
        }
        $password = (string) ($body["password"] ?? $body["loginPassword"] ?? "");
        if (strlen($password) < 8) {
            send_json(400, ["error" => "Give the sponsor a password of at least 8 characters."]);
        }
        $orgs = read_json("organisations.json");
        $sites = read_json("sites.json");
        $users = read_json("users.json");
        foreach ($users as $item) {
            if (($item["username"] ?? "") === $username) {
                send_json(400, ["error" => "That login name is already used."]);
            }
        }
        $publicEmail = $listing["kind"] === "shop" ? "" : substr(trim((string) ($body["publicEmail"] ?? $body["email"] ?? "")), 0, 120);
        if ($listing["kind"] !== "shop" && !preg_match('/^[^\s@]+@[^\s@]+\.[^\s@]+$/', $publicEmail)) {
            send_json(400, ["error" => "Enter the public email address."]);
        }
        $photosIn = is_array($body["photos"] ?? null) ? $body["photos"] : [];
        if (count($photosIn) > 20) {
            send_json(400, ["error" => "A listing can have at most 20 photographs."]);
        }
        $generic = parse_generic_code((string) ($body["genericCode"] ?? $body["listingId"] ?? ""));
        if ($generic) {
            if (generic_listing_taken($sites, $orgs, $generic)) {
                send_json(400, ["error" => "That QR code ({$generic["label"]}) is already used."]);
            }
        } else {
            $generic = next_generic_code($sites, $orgs);
        }
        $subscribedAt = preg_match('/^\d{4}-\d{2}-\d{2}$/', (string) ($body["subscribedAt"] ?? "")) ? $body["subscribedAt"] : date("Y-m-d");
        $number = 0;
        foreach ($orgs as $org) {
            $number = max($number, (int) ($org["number"] ?? 0));
        }
        $number += 1;
        $listingId = $generic["listingId"];
        $slug = slugify_id($name);
        $organisationId = $listing["kind"] === "shop" ? $listingId : (($slug !== "" && !find_org($orgs, $slug)) ? $slug : $listingId);
        if (find_org($orgs, $organisationId)) {
            send_json(400, ["error" => "That listing is already in the catalogue."]);
        }
        $referrer = find_referrer($orgs, $sites, $users, (string) ($body["referredBy"] ?? ""));
        $referralNote = "";
        if (trim((string) ($body["referredBy"] ?? "")) !== "" && !$referrer) {
            $referralNote = "Saved without a referral credit — that referrer was not found.";
        }
        if ($referrer && ($referrer["id"] ?? "") !== $organisationId) {
            foreach ($orgs as $index => $org) {
                if (($org["id"] ?? "") === ($referrer["id"] ?? "")) {
                    $orgs[$index]["extraMonths"] = extra_months($org) + 1;
                }
            }
        }
        $organisation = [
            "number" => $number,
            "id" => $organisationId,
            "name" => $name,
            "type" => $listing["type"],
            "kind" => $listing["kind"],
            "email" => $publicEmail,
            "contactName" => $contactName,
            "contactEmail" => $contactEmail,
            "subscribedAt" => $subscribedAt,
            "createdAt" => $subscribedAt,
            "referralCode" => $generic["label"],
            "extraMonths" => 0,
            "referredBy" => ($referrer && ($referrer["id"] ?? "") !== $organisationId) ? $referrer["id"] : "",
        ];
        if ($listing["kind"] === "shop") {
            $organisation["shopGroup"] = $listing["shopGroup"];
        }
        $codes = collect_codes($sites);
        $photoMeta = [];
        if (!is_dir($imageDir)) {
            mkdir($imageDir, 0755, true);
        }
        foreach ($photosIn as $photo) {
            $code = next_photo_code($number, $codes);
            $codes[] = $code;
            $upload = image_from_payload((string) ($photo["dataUrl"] ?? $photo["jpeg"] ?? $photo["url"] ?? ""));
            $ext = $upload["ext"];
            file_put_contents($imageDir . DIRECTORY_SEPARATOR . $code . "." . $ext, $upload["binary"]);
            $photoMeta[] = [
                "code" => $code,
                "url" => "images/{$code}.{$ext}",
                "caption" => trim((string) ($photo["caption"] ?? "")),
                "credit" => trim((string) ($photo["credit"] ?? "")),
                "kind" => (($photo["kind"] ?? "") === "historical") ? "historical" : "current",
            ];
        }
        $site = [
            "id" => $listingId,
            "organisationId" => $organisationId,
            "name" => $name,
            "genericCode" => $generic["label"],
            "buildYear" => "",
            "yearStart" => null,
            "yearEnd" => null,
            "circa" => false,
            "category" => $listing["category"],
            "shopGroup" => $listing["shopGroup"],
            "country" => "Australia",
            "state" => "Victoria",
            "city" => "Geelong",
            "suburb" => "",
            "mapArea" => "",
            "mapsQuery" => "",
            "description" => trim((string) ($body["description"] ?? "")),
            "facts" => [],
            "furtherReading" => trim((string) ($body["website"] ?? $body["furtherReading"] ?? "")),
            "sources" => [],
            "createdAt" => $subscribedAt,
            "photos" => $photoMeta,
        ];
        $orgs[] = $organisation;
        $sites[] = $site;
        $users[] = array_merge([
            "username" => $username,
            "role" => "sponsor",
            "organisationId" => $organisationId,
        ], hash_password($password));
        write_json("organisations.json", $orgs);
        write_json("sites.json", $sites);
        write_json("users.json", $users);
        $publicUrl = "https://touristqr.com/" . $generic["label"];
        $kindWord = $listing["type"] === "Restaurant" ? "restaurant" : ($listing["kind"] === "shop" ? "shop" : "site");
        $email = welcome_email([
            "contactName" => $contactName,
            "businessName" => $name,
            "listingKind" => $kindWord,
            "username" => $username,
            "password" => $password,
            "publicUrl" => $publicUrl,
            "genericLabel" => $generic["label"],
            "subscribedAt" => $subscribedAt,
            "extraMonths" => 0,
        ]);
        $clientGeneric = parse_generic_code((string) ($body["genericCode"] ?? ""));
        $png = ($clientGeneric && $clientGeneric["listingId"] === $generic["listingId"])
            ? png_from_payload((string) ($body["qrPng"] ?? ""))
            : null;
        $mail = send_signup_mail($email, $contactEmail, $png);
        log_activity(["action" => "signup", "organisationId" => $organisationId, "listingId" => $listingId, "generic" => $generic["label"], "by" => $admin["username"]]);
        send_json(200, [
            "organisationId" => $organisationId,
            "listingId" => $listingId,
            "businessName" => $name,
            "generic" => $generic,
            "publicUrl" => $publicUrl,
            "previewUrl" => "/" . $generic["label"],
            "contactEmail" => $contactEmail,
            "emailSent" => $mail["sent"],
            "emailNote" => $mail["note"],
            "referralNote" => $referralNote,
        ]);
    }

    send_json(404, ["error" => "Not found."]);
} catch (Throwable $error) {
    send_json(500, ["error" => "The server could not finish that."]);
}
