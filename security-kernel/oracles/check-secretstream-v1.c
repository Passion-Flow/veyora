/* Independent C decrypt/shape checker for Veyora native-backup-v1 fixtures. */
#define _POSIX_C_SOURCE 200809L

#include <dirent.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#include <sodium.h>

enum {
    BACKUP_CHUNK_BYTES = 4194304,
    STREAM_OVERHEAD_BYTES = 17,
    MAX_FIXTURE_FILE_BYTES = BACKUP_CHUNK_BYTES + STREAM_OVERHEAD_BYTES,
    FINAL_MAX_BYTES = 128,
    AAD_MAX_BYTES = 96,
    PATH_BYTES = 4096
};

typedef struct {
    const char *name;
    unsigned int id;
    uint64_t logical_size;
    size_t message_count;
} fixture_case;

typedef struct {
    char case_name[32];
    uint64_t logical_size;
    size_t message_count;
    size_t frame_count;
    size_t backup_header_bytes;
} fixture_metadata;

static const fixture_case CASES[] = {
    {"empty", 1U, UINT64_C(0), 1U},
    {"one-byte", 2U, UINT64_C(1), 1U},
    {"exact-chunk", 3U, UINT64_C(4194304), 1U},
    {"multi-chunk", 4U, UINT64_C(4194305), 2U}
};

static int select_case(const char *name, fixture_case *selected)
{
    size_t index;
    for (index = 0; index < sizeof CASES / sizeof CASES[0]; index++) {
        if (strcmp(name, CASES[index].name) == 0) {
            *selected = CASES[index];
            return 0;
        }
    }
    return -1;
}

static int build_path(char output[PATH_BYTES], const char *directory, const char *name)
{
    const int length = snprintf(output, PATH_BYTES, "%s/%s", directory, name);
    return length < 0 || length >= PATH_BYTES ? -1 : 0;
}

static int read_regular_file(const char *directory, const char *name,
                             unsigned char **output, size_t *length)
{
    char path[PATH_BYTES];
    struct stat status;
    FILE *file;
    unsigned char *bytes;
    if (build_path(path, directory, name) != 0 || lstat(path, &status) != 0 ||
        !S_ISREG(status.st_mode) || status.st_size <= 0 ||
        (unsigned long long) status.st_size > MAX_FIXTURE_FILE_BYTES) return -1;
    *length = (size_t) status.st_size;
    bytes = malloc(*length + 1U);
    if (bytes == NULL || (file = fopen(path, "rb")) == NULL) {
        free(bytes);
        return -1;
    }
    if (fread(bytes, 1U, *length, file) != *length || fclose(file) != 0) {
        free(bytes);
        return -1;
    }
    bytes[*length] = 0U;
    *output = bytes;
    return 0;
}

static int parse_unsigned(const char *line, const char *prefix, uint64_t *value)
{
    char *end = NULL;
    unsigned long long parsed;
    if (strncmp(line, prefix, strlen(prefix)) != 0) return -1;
    errno = 0;
    parsed = strtoull(line + strlen(prefix), &end, 10);
    if (errno != 0 || end == line + strlen(prefix) || *end != '\0') return -1;
    *value = (uint64_t) parsed;
    return 0;
}

static int read_metadata(const char *directory, fixture_metadata *metadata)
{
    unsigned char *bytes = NULL;
    size_t length = 0U;
    char *save = NULL;
    char *line;
    size_t line_number = 0U;
    uint64_t parsed;
    int result = -1;
    if (read_regular_file(directory, "metadata.txt", &bytes, &length) != 0) return -1;
    (void) length;
    memset(metadata, 0, sizeof *metadata);
    for (line = strtok_r((char *) bytes, "\n", &save); line != NULL;
         line = strtok_r(NULL, "\n", &save)) {
        switch (line_number++) {
        case 0:
            if (strcmp(line, "format=veyora-secretstream-oracle-v1") != 0) goto done;
            break;
        case 1:
            if (sscanf(line, "case=%31[a-z-]", metadata->case_name) != 1) goto done;
            break;
        case 2:
            if (parse_unsigned(line, "logical_size=", &metadata->logical_size) != 0) goto done;
            break;
        case 3:
            if (parse_unsigned(line, "message_count=", &parsed) != 0) goto done;
            metadata->message_count = (size_t) parsed;
            break;
        case 4:
            if (parse_unsigned(line, "frame_count=", &parsed) != 0) goto done;
            metadata->frame_count = (size_t) parsed;
            break;
        case 5:
            if (strcmp(line, "chunk_plaintext_bytes=4194304") != 0) goto done;
            break;
        case 6:
            if (strcmp(line, "secretstream_overhead=17") != 0) goto done;
            break;
        case 7:
            if (parse_unsigned(line, "backup_header_bytes=", &parsed) != 0) goto done;
            metadata->backup_header_bytes = (size_t) parsed;
            break;
        case 8:
            if (strcmp(line, "library_version=1.0.22") != 0) goto done;
            break;
        default:
            goto done;
        }
    }
    if (line_number != 9U || metadata->message_count + 1U != metadata->frame_count ||
        metadata->frame_count < 2U || metadata->frame_count > 3U) goto done;
    result = 0;
done:
    free(bytes);
    return result;
}

static int expected_filename(const fixture_metadata *metadata, const char *name)
{
    static const char *fixed[] = {
        "metadata.txt", "key.bin", "header.bin", "backup-header.bin",
        "backup-header-sha256.bin", "logical-snapshot-sha256.bin"
    };
    static const char *parts[] = {"aad.bin", "plaintext.bin", "ciphertext.bin", "tag"};
    char expected[64];
    size_t index;
    size_t part;
    for (index = 0; index < sizeof fixed / sizeof fixed[0]; index++) {
        if (strcmp(name, fixed[index]) == 0) return 1;
    }
    for (index = 0; index < metadata->frame_count; index++) {
        for (part = 0; part < sizeof parts / sizeof parts[0]; part++) {
            if (snprintf(expected, sizeof expected, "frame-%03zu.%s", index, parts[part]) > 0 &&
                strcmp(name, expected) == 0) return 1;
        }
        if (index < metadata->message_count &&
            snprintf(expected, sizeof expected, "frame-%03zu.padding-seed.bin", index) > 0 &&
            strcmp(name, expected) == 0) return 1;
    }
    return 0;
}

static int validate_directory_entries(const char *directory, const fixture_metadata *metadata)
{
    DIR *stream = opendir(directory);
    struct dirent *entry;
    if (stream == NULL) return -1;
    errno = 0;
    while ((entry = readdir(stream)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        if (!expected_filename(metadata, entry->d_name)) {
            closedir(stream);
            return -1;
        }
    }
    if (errno != 0 || closedir(stream) != 0) return -1;
    return 0;
}

static int append_byte(unsigned char *output, const size_t capacity, size_t *offset,
                       const unsigned char value)
{
    if (*offset >= capacity) return -1;
    output[(*offset)++] = value;
    return 0;
}

static int append_bytes(unsigned char *output, const size_t capacity, size_t *offset,
                        const unsigned char *value, const size_t length)
{
    if (length > capacity - *offset) return -1;
    memcpy(output + *offset, value, length);
    *offset += length;
    return 0;
}

static int append_uint(unsigned char *output, const size_t capacity, size_t *offset,
                       const uint64_t value)
{
    if (value < 24U) return append_byte(output, capacity, offset, (unsigned char) value);
    if (value <= UINT8_MAX)
        return append_byte(output, capacity, offset, 0x18U) || append_byte(output, capacity, offset, (unsigned char) value);
    if (value <= UINT16_MAX)
        return append_byte(output, capacity, offset, 0x19U) || append_byte(output, capacity, offset, (unsigned char) (value >> 8)) || append_byte(output, capacity, offset, (unsigned char) value);
    if (value <= UINT32_MAX)
        return append_byte(output, capacity, offset, 0x1aU) || append_byte(output, capacity, offset, (unsigned char) (value >> 24)) || append_byte(output, capacity, offset, (unsigned char) (value >> 16)) || append_byte(output, capacity, offset, (unsigned char) (value >> 8)) || append_byte(output, capacity, offset, (unsigned char) value);
    return -1;
}

static int build_aad(const unsigned char header_hash[crypto_hash_sha256_BYTES],
                     const uint64_t index, const uint64_t kind, const uint64_t count,
                     unsigned char output[AAD_MAX_BYTES], size_t *length)
{
    static const unsigned char domain[] = "pm-v1/backup-frame";
    size_t offset = 0U;
    if (append_bytes(output, AAD_MAX_BYTES, &offset, domain, sizeof domain - 1U) != 0 ||
        append_byte(output, AAD_MAX_BYTES, &offset, 0U) != 0 ||
        append_byte(output, AAD_MAX_BYTES, &offset, 0x84U) != 0 ||
        append_byte(output, AAD_MAX_BYTES, &offset, 0x58U) != 0 ||
        append_byte(output, AAD_MAX_BYTES, &offset, 0x20U) != 0 ||
        append_bytes(output, AAD_MAX_BYTES, &offset, header_hash, crypto_hash_sha256_BYTES) != 0 ||
        append_uint(output, AAD_MAX_BYTES, &offset, index) != 0 ||
        append_uint(output, AAD_MAX_BYTES, &offset, kind) != 0 ||
        append_uint(output, AAD_MAX_BYTES, &offset, count) != 0) return -1;
    *length = offset;
    return 0;
}

static int hash_zero_bytes(const uint64_t length, unsigned char digest[crypto_hash_sha256_BYTES])
{
    crypto_hash_sha256_state state;
    unsigned char zeros[65536] = {0};
    uint64_t remaining = length;
    if (crypto_hash_sha256_init(&state) != 0) return -1;
    while (remaining > 0U) {
        const size_t amount = remaining > sizeof zeros ? sizeof zeros : (size_t) remaining;
        if (crypto_hash_sha256_update(&state, zeros, amount) != 0) return -1;
        remaining -= amount;
    }
    return crypto_hash_sha256_final(&state, digest);
}

static void padding_seed(const fixture_case *selected, const size_t index,
                         unsigned char seed[randombytes_SEEDBYTES])
{
    size_t offset;
    for (offset = 0; offset < randombytes_SEEDBYTES; offset++)
        seed[offset] = (unsigned char) (0x51U + selected->id * 19U + index * 31U + offset);
}

static int build_final_plaintext(
    const unsigned char header_hash[crypto_hash_sha256_BYTES], const fixture_case *selected,
    const unsigned char logical_hash[crypto_hash_sha256_BYTES],
    unsigned char output[FINAL_MAX_BYTES], size_t *length)
{
    size_t offset = 0U;
    const uint64_t padded_length = (uint64_t) selected->message_count * BACKUP_CHUNK_BYTES;
    if (append_byte(output, FINAL_MAX_BYTES, &offset, 0x85U) != 0 ||
        append_byte(output, FINAL_MAX_BYTES, &offset, 0x58U) != 0 ||
        append_byte(output, FINAL_MAX_BYTES, &offset, 0x20U) != 0 ||
        append_bytes(output, FINAL_MAX_BYTES, &offset, header_hash, crypto_hash_sha256_BYTES) != 0 ||
        append_uint(output, FINAL_MAX_BYTES, &offset, selected->message_count) != 0 ||
        append_uint(output, FINAL_MAX_BYTES, &offset, selected->logical_size) != 0 ||
        append_uint(output, FINAL_MAX_BYTES, &offset, padded_length) != 0 ||
        append_byte(output, FINAL_MAX_BYTES, &offset, 0x58U) != 0 ||
        append_byte(output, FINAL_MAX_BYTES, &offset, 0x20U) != 0 ||
        append_bytes(output, FINAL_MAX_BYTES, &offset, logical_hash, crypto_hash_sha256_BYTES) != 0) return -1;
    *length = offset;
    return 0;
}

static int read_frame_file(const char *directory, const size_t index, const char *suffix,
                           unsigned char **bytes, size_t *length)
{
    char name[64];
    const int count = snprintf(name, sizeof name, "frame-%03zu.%s", index, suffix);
    if (count < 0 || (size_t) count >= sizeof name) return -1;
    return read_regular_file(directory, name, bytes, length);
}

int main(int argc, char **argv)
{
    fixture_metadata metadata;
    fixture_case selected;
    crypto_secretstream_xchacha20poly1305_state stream;
    unsigned char *key = NULL;
    unsigned char *stream_header = NULL;
    unsigned char *backup_header = NULL;
    unsigned char *stored_header_hash = NULL;
    unsigned char *stored_logical_hash = NULL;
    unsigned char header_hash[crypto_hash_sha256_BYTES];
    unsigned char logical_hash[crypto_hash_sha256_BYTES];
    size_t key_length = 0U, stream_header_length = 0U, backup_header_length = 0U;
    size_t stored_header_hash_length = 0U, stored_logical_hash_length = 0U;
    size_t index;
    int exit_code = 70;

    if (argc != 2) {
        fprintf(stderr, "usage: %s FIXTURE_DIRECTORY\n", argv[0]);
        return 64;
    }
    if (sodium_init() < 0 || strcmp(sodium_version_string(), "1.0.22") != 0 ||
        crypto_secretstream_xchacha20poly1305_abytes() != STREAM_OVERHEAD_BYTES ||
        read_metadata(argv[1], &metadata) != 0 || select_case(metadata.case_name, &selected) != 0 ||
        metadata.logical_size != selected.logical_size ||
        metadata.message_count != selected.message_count ||
        validate_directory_entries(argv[1], &metadata) != 0) {
        fprintf(stderr, "fixture metadata or directory shape is invalid\n");
        return 70;
    }
    if (read_regular_file(argv[1], "key.bin", &key, &key_length) != 0 ||
        read_regular_file(argv[1], "header.bin", &stream_header, &stream_header_length) != 0 ||
        read_regular_file(argv[1], "backup-header.bin", &backup_header, &backup_header_length) != 0 ||
        read_regular_file(argv[1], "backup-header-sha256.bin", &stored_header_hash, &stored_header_hash_length) != 0 ||
        read_regular_file(argv[1], "logical-snapshot-sha256.bin", &stored_logical_hash, &stored_logical_hash_length) != 0 ||
        key_length != crypto_secretstream_xchacha20poly1305_KEYBYTES ||
        stream_header_length != crypto_secretstream_xchacha20poly1305_HEADERBYTES ||
        backup_header_length != metadata.backup_header_bytes || backup_header_length < 26U ||
        backup_header[backup_header_length - 26U] != 0x58U ||
        backup_header[backup_header_length - 25U] != 0x18U ||
        sodium_memcmp(backup_header + backup_header_length - 24U, stream_header, 24U) != 0 ||
        stored_header_hash_length != crypto_hash_sha256_BYTES ||
        stored_logical_hash_length != crypto_hash_sha256_BYTES ||
        crypto_hash_sha256(header_hash, backup_header, backup_header_length) != 0 ||
        hash_zero_bytes(selected.logical_size, logical_hash) != 0 ||
        sodium_memcmp(header_hash, stored_header_hash, sizeof header_hash) != 0 ||
        sodium_memcmp(logical_hash, stored_logical_hash, sizeof logical_hash) != 0 ||
        crypto_secretstream_xchacha20poly1305_init_pull(&stream, stream_header, key) != 0) {
        fprintf(stderr, "fixture key, header, or digest is invalid\n");
        goto done;
    }

    for (index = 0; index < metadata.frame_count; index++) {
        unsigned char *aad = NULL, *plaintext = NULL, *ciphertext = NULL, *tag_text = NULL;
        unsigned char *seed_file = NULL, *decrypted = NULL, *expected = NULL;
        size_t aad_length = 0U, plaintext_length = 0U, ciphertext_length = 0U;
        size_t tag_length = 0U, seed_length = 0U, expected_aad_length = 0U;
        unsigned long long decrypted_length = 0U;
        unsigned char actual_tag = 0xffU;
        unsigned char expected_aad[AAD_MAX_BYTES];
        const int is_final = index == metadata.message_count;
        int valid = 0;
        if (read_frame_file(argv[1], index, "aad.bin", &aad, &aad_length) != 0 ||
            read_frame_file(argv[1], index, "plaintext.bin", &plaintext, &plaintext_length) != 0 ||
            read_frame_file(argv[1], index, "ciphertext.bin", &ciphertext, &ciphertext_length) != 0 ||
            read_frame_file(argv[1], index, "tag", &tag_text, &tag_length) != 0 ||
            build_aad(header_hash, index, is_final ? 2U : 1U, metadata.message_count,
                      expected_aad, &expected_aad_length) != 0 ||
            aad_length != expected_aad_length || sodium_memcmp(aad, expected_aad, aad_length) != 0 ||
            ciphertext_length != plaintext_length + STREAM_OVERHEAD_BYTES ||
            (is_final ? strcmp((char *) tag_text, "FINAL\n") : strcmp((char *) tag_text, "MESSAGE\n")) != 0) {
            fprintf(stderr, "fixture frame %zu shape/AAD is invalid\n", index);
            goto frame_done;
        }
        decrypted = malloc(plaintext_length);
        if (decrypted == NULL || crypto_secretstream_xchacha20poly1305_pull(
                &stream, decrypted, &decrypted_length, &actual_tag, ciphertext,
                ciphertext_length, aad, aad_length) != 0 || decrypted_length != plaintext_length ||
            sodium_memcmp(decrypted, plaintext, plaintext_length) != 0 ||
            actual_tag != (is_final ? crypto_secretstream_xchacha20poly1305_TAG_FINAL
                                    : crypto_secretstream_xchacha20poly1305_TAG_MESSAGE)) {
            fprintf(stderr, "fixture frame %zu authentication failed\n", index);
            goto frame_done;
        }
        if (!is_final) {
            unsigned char seed[randombytes_SEEDBYTES];
            const uint64_t logical_offset = (uint64_t) index * BACKUP_CHUNK_BYTES;
            const size_t logical_in_frame = selected.logical_size > logical_offset
                ? (size_t) ((selected.logical_size - logical_offset) > BACKUP_CHUNK_BYTES
                    ? BACKUP_CHUNK_BYTES : selected.logical_size - logical_offset) : 0U;
            if (plaintext_length != BACKUP_CHUNK_BYTES ||
                read_frame_file(argv[1], index, "padding-seed.bin", &seed_file, &seed_length) != 0 ||
                seed_length != randombytes_SEEDBYTES) goto frame_done;
            padding_seed(&selected, index, seed);
            if (sodium_memcmp(seed, seed_file, sizeof seed) != 0) goto frame_done;
            expected = calloc(1U, BACKUP_CHUNK_BYTES);
            if (expected == NULL) goto frame_done;
            if (logical_in_frame < BACKUP_CHUNK_BYTES)
                randombytes_buf_deterministic(expected + logical_in_frame,
                                              BACKUP_CHUNK_BYTES - logical_in_frame, seed);
            if (sodium_memcmp(expected, plaintext, BACKUP_CHUNK_BYTES) != 0) goto frame_done;
        } else {
            unsigned char expected_final[FINAL_MAX_BYTES];
            size_t expected_final_length = 0U;
            if (build_final_plaintext(header_hash, &selected, logical_hash, expected_final,
                                      &expected_final_length) != 0 ||
                plaintext_length != expected_final_length ||
                sodium_memcmp(expected_final, plaintext, plaintext_length) != 0) goto frame_done;
        }
        valid = 1;
frame_done:
        if (decrypted != NULL) sodium_memzero(decrypted, plaintext_length);
        if (expected != NULL) sodium_memzero(expected, BACKUP_CHUNK_BYTES);
        free(expected); free(decrypted); free(seed_file); free(tag_text);
        free(ciphertext); free(plaintext); free(aad);
        if (!valid) goto done;
    }
    printf("%s: PASS\n", metadata.case_name);
    exit_code = 0;
done:
    sodium_memzero(&stream, sizeof stream);
    if (key != NULL) sodium_memzero(key, key_length);
    free(stored_logical_hash); free(stored_header_hash); free(backup_header);
    free(stream_header); free(key);
    return exit_code;
}
