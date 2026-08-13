/*
 * Veyora native-backup-v1 standalone fixture generator.
 *
 * This program is independent of Rust product code and links only to the
 * source-built, hash-verified libsodium 1.0.22 static archive. It implements
 * the exact ADR 0001 backup header, 4 MiB data frames, header-bound AAD, and
 * canonical five-field FINAL footer. Deterministic entropy is fixture-only.
 */
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <sodium.h>

enum {
    BACKUP_CHUNK_BYTES = 4194304,
    STREAM_OVERHEAD_BYTES = 17,
    HEADER_MAX_BYTES = 216,
    FINAL_MAX_BYTES = 128,
    AAD_MAX_BYTES = 96,
    PATH_BYTES = 4096
};

typedef struct {
    const char *name;
    unsigned int id;
    uint64_t logical_size;
    size_t message_count;
    const char *header_prefix_hex;
} fixture_case;

static uint64_t deterministic_header_state;

static const fixture_case FIXTURE_CASES[] = {
    {
        "empty", 1U, UINT64_C(0), 1U,
        "9201010150000102030405060708090a0b0c0d0e0f50101112131415161718191a1b1c1d1e1f"
        "502020202020202020202020202020202050303132333435363738393a3b3c3d3e3f0158204041"
        "42434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f015820606162636465"
        "666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f01582080818283848586878889"
        "8a8b8c8d8e8f909192939495969798999a9b9c9d9e9f81001a004000000001"
    },
    {
        "one-byte", 2U, UINT64_C(1), 1U,
        "9201010150000102030405060708090a0b0c0d0e0f50101112131415161718191a1b1c1d1e1f"
        "502121212121212121212121212121212150303132333435363738393a3b3c3d3e3f0158204041"
        "42434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f015820606162636465"
        "666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f01582080818283848586878889"
        "8a8b8c8d8e8f909192939495969798999a9b9c9d9e9f81001a004000000101"
    },
    {
        "exact-chunk", 3U, UINT64_C(4194304), 1U,
        "9201010150000102030405060708090a0b0c0d0e0f50101112131415161718191a1b1c1d1e1f"
        "502222222222222222222222222222222250303132333435363738393a3b3c3d3e3f0158204041"
        "42434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f015820606162636465"
        "666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f01582080818283848586878889"
        "8a8b8c8d8e8f909192939495969798999a9b9c9d9e9f81001a004000001a0040000001"
    },
    {
        "multi-chunk", 4U, UINT64_C(4194305), 2U,
        "9201010150000102030405060708090a0b0c0d0e0f50101112131415161718191a1b1c1d1e1f"
        "502323232323232323232323232323232350303132333435363738393a3b3c3d3e3f0158204041"
        "42434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f015820606162636465"
        "666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f01582080818283848586878889"
        "8a8b8c8d8e8f909192939495969798999a9b9c9d9e9f81001a004000001a0040000102"
    }
};

static const char *deterministic_name(void)
{
    return "veyora-secretstream-v1-header-fixture-only";
}

static void deterministic_buf(void *const output, const size_t size)
{
    unsigned char *bytes = output;
    size_t index;

    for (index = 0; index < size; index++) {
        deterministic_header_state ^= deterministic_header_state >> 12;
        deterministic_header_state ^= deterministic_header_state << 25;
        deterministic_header_state ^= deterministic_header_state >> 27;
        deterministic_header_state *= UINT64_C(2685821657736338717);
        bytes[index] = (unsigned char) (deterministic_header_state >> 56);
    }
}

static uint32_t deterministic_random(void)
{
    uint32_t value;
    deterministic_buf(&value, sizeof value);
    return value;
}

static randombytes_implementation deterministic_implementation = {
    deterministic_name,
    deterministic_random,
    NULL,
    NULL,
    deterministic_buf,
    NULL
};

static int select_case(const char *name, fixture_case *selected)
{
    size_t index;
    for (index = 0; index < sizeof FIXTURE_CASES / sizeof FIXTURE_CASES[0]; index++) {
        if (strcmp(name, FIXTURE_CASES[index].name) == 0) {
            *selected = FIXTURE_CASES[index];
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

static int write_bytes(const char *directory, const char *name,
                       const unsigned char *bytes, const size_t length)
{
    char path[PATH_BYTES];
    FILE *file;
    if (build_path(path, directory, name) != 0 || (file = fopen(path, "wb")) == NULL) {
        return -1;
    }
    if ((length > 0U && fwrite(bytes, 1U, length, file) != length) || fclose(file) != 0) {
        return -1;
    }
    return 0;
}

static int write_text(const char *directory, const char *name, const char *text)
{
    return write_bytes(directory, name, (const unsigned char *) text, strlen(text));
}

static int hex_value(const char value)
{
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    return -1;
}

static int decode_hex(const char *hex, unsigned char *output, const size_t capacity,
                      size_t *output_length)
{
    const size_t length = strlen(hex);
    size_t index;
    if (length == 0U || length % 2U != 0U || length / 2U > capacity) return -1;
    for (index = 0; index < length / 2U; index++) {
        const int high = hex_value(hex[index * 2U]);
        const int low = hex_value(hex[index * 2U + 1U]);
        if (high < 0 || low < 0) return -1;
        output[index] = (unsigned char) ((high << 4) | low);
    }
    *output_length = length / 2U;
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
    if (value <= UINT8_MAX) {
        return append_byte(output, capacity, offset, 0x18U) ||
               append_byte(output, capacity, offset, (unsigned char) value);
    }
    if (value <= UINT16_MAX) {
        return append_byte(output, capacity, offset, 0x19U) ||
               append_byte(output, capacity, offset, (unsigned char) (value >> 8)) ||
               append_byte(output, capacity, offset, (unsigned char) value);
    }
    if (value <= UINT32_MAX) {
        return append_byte(output, capacity, offset, 0x1aU) ||
               append_byte(output, capacity, offset, (unsigned char) (value >> 24)) ||
               append_byte(output, capacity, offset, (unsigned char) (value >> 16)) ||
               append_byte(output, capacity, offset, (unsigned char) (value >> 8)) ||
               append_byte(output, capacity, offset, (unsigned char) value);
    }
    return -1;
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
    for (offset = 0; offset < randombytes_SEEDBYTES; offset++) {
        seed[offset] = (unsigned char) (0x51U + selected->id * 19U + index * 31U + offset);
    }
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

static int build_final_plaintext(
    const unsigned char header_hash[crypto_hash_sha256_BYTES],
    const fixture_case *selected,
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
        append_bytes(output, FINAL_MAX_BYTES, &offset, logical_hash, crypto_hash_sha256_BYTES) != 0)
        return -1;
    *length = offset;
    return 0;
}

static int write_frame_files(const char *directory, const size_t index,
                             const unsigned char *aad, const size_t aad_length,
                             const unsigned char *plaintext, const size_t plaintext_length,
                             const unsigned char *ciphertext, const size_t ciphertext_length,
                             const char *tag, const unsigned char *seed)
{
    char name[64];
#define WRITE_PART(suffix, value, length)                                                   \
    do {                                                                                    \
        const int count = snprintf(name, sizeof name, "frame-%03zu.%s", index, suffix);     \
        if (count < 0 || (size_t) count >= sizeof name ||                                   \
            write_bytes(directory, name, value, length) != 0) return -1;                   \
    } while (0)
    WRITE_PART("aad.bin", aad, aad_length);
    WRITE_PART("plaintext.bin", plaintext, plaintext_length);
    WRITE_PART("ciphertext.bin", ciphertext, ciphertext_length);
    if (seed != NULL) WRITE_PART("padding-seed.bin", seed, randombytes_SEEDBYTES);
    {
        const int count = snprintf(name, sizeof name, "frame-%03zu.tag", index);
        if (count < 0 || (size_t) count >= sizeof name || write_text(directory, name, tag) != 0)
            return -1;
    }
#undef WRITE_PART
    return 0;
}

int main(int argc, char **argv)
{
    fixture_case selected;
    crypto_secretstream_xchacha20poly1305_state stream;
    unsigned char key[crypto_secretstream_xchacha20poly1305_KEYBYTES];
    unsigned char stream_header[crypto_secretstream_xchacha20poly1305_HEADERBYTES];
    unsigned char backup_header[HEADER_MAX_BYTES];
    unsigned char header_hash[crypto_hash_sha256_BYTES];
    unsigned char logical_hash[crypto_hash_sha256_BYTES];
    size_t header_prefix_length = 0U;
    size_t backup_header_length;
    size_t index;
    char metadata[768];
    int metadata_length;

    if (argc != 3) {
        fprintf(stderr, "usage: %s CASE OUTPUT_DIRECTORY\n", argv[0]);
        return 64;
    }
    if (select_case(argv[1], &selected) != 0) {
        fprintf(stderr, "unsupported fixture case: %s\n", argv[1]);
        return 64;
    }
    deterministic_header_state = UINT64_C(0x6a09e667f3bcc909) ^ ((uint64_t) selected.id << 32);
    if (randombytes_set_implementation(&deterministic_implementation) != 0 ||
        sodium_init() < 0 || strcmp(sodium_version_string(), "1.0.22") != 0 ||
        crypto_secretstream_xchacha20poly1305_abytes() != STREAM_OVERHEAD_BYTES) {
        fprintf(stderr, "verified libsodium 1.0.22 initialization failed\n");
        return 70;
    }
    for (index = 0; index < sizeof key; index++) {
        key[index] = (unsigned char) (selected.id * 29U + index + 1U);
    }
    if (crypto_secretstream_xchacha20poly1305_init_push(&stream, stream_header, key) != 0 ||
        decode_hex(selected.header_prefix_hex, backup_header, sizeof backup_header,
                   &header_prefix_length) != 0 ||
        header_prefix_length + 26U > sizeof backup_header) {
        fprintf(stderr, "backup header initialization failed\n");
        return 70;
    }
    backup_header[header_prefix_length] = 0x58U;
    backup_header[header_prefix_length + 1U] = 0x18U;
    memcpy(backup_header + header_prefix_length + 2U, stream_header, sizeof stream_header);
    backup_header_length = header_prefix_length + 2U + sizeof stream_header;
    if (crypto_hash_sha256(header_hash, backup_header, backup_header_length) != 0 ||
        hash_zero_bytes(selected.logical_size, logical_hash) != 0 ||
        write_bytes(argv[2], "key.bin", key, sizeof key) != 0 ||
        write_bytes(argv[2], "header.bin", stream_header, sizeof stream_header) != 0 ||
        write_bytes(argv[2], "backup-header.bin", backup_header, backup_header_length) != 0 ||
        write_bytes(argv[2], "backup-header-sha256.bin", header_hash, sizeof header_hash) != 0 ||
        write_bytes(argv[2], "logical-snapshot-sha256.bin", logical_hash, sizeof logical_hash) != 0) {
        fprintf(stderr, "backup header evidence write failed: %s\n", strerror(errno));
        return 74;
    }

    for (index = 0; index < selected.message_count; index++) {
        unsigned char *plaintext = malloc(BACKUP_CHUNK_BYTES);
        unsigned char *ciphertext = malloc(BACKUP_CHUNK_BYTES + STREAM_OVERHEAD_BYTES);
        unsigned char aad[AAD_MAX_BYTES];
        unsigned char seed[randombytes_SEEDBYTES];
        unsigned long long ciphertext_length = 0U;
        size_t aad_length = 0U;
        const uint64_t logical_offset = (uint64_t) index * BACKUP_CHUNK_BYTES;
        const size_t logical_in_frame = selected.logical_size > logical_offset
            ? (size_t) ((selected.logical_size - logical_offset) > BACKUP_CHUNK_BYTES
                ? BACKUP_CHUNK_BYTES : selected.logical_size - logical_offset)
            : 0U;
        if (plaintext == NULL || ciphertext == NULL) return 71;
        memset(plaintext, 0, logical_in_frame);
        padding_seed(&selected, index, seed);
        if (logical_in_frame < BACKUP_CHUNK_BYTES) {
            randombytes_buf_deterministic(plaintext + logical_in_frame,
                                          BACKUP_CHUNK_BYTES - logical_in_frame, seed);
        }
        if (build_aad(header_hash, index, 1U, selected.message_count, aad, &aad_length) != 0 ||
            crypto_secretstream_xchacha20poly1305_push(
                &stream, ciphertext, &ciphertext_length, plaintext, BACKUP_CHUNK_BYTES,
                aad, aad_length, crypto_secretstream_xchacha20poly1305_TAG_MESSAGE) != 0 ||
            ciphertext_length != BACKUP_CHUNK_BYTES + STREAM_OVERHEAD_BYTES ||
            write_frame_files(argv[2], index, aad, aad_length, plaintext,
                              BACKUP_CHUNK_BYTES, ciphertext, (size_t) ciphertext_length,
                              "MESSAGE\n", seed) != 0) {
            fprintf(stderr, "MESSAGE frame generation failed\n");
            return 70;
        }
        sodium_memzero(plaintext, BACKUP_CHUNK_BYTES);
        sodium_memzero(ciphertext, BACKUP_CHUNK_BYTES + STREAM_OVERHEAD_BYTES);
        free(plaintext);
        free(ciphertext);
    }
    {
        unsigned char plaintext[FINAL_MAX_BYTES];
        unsigned char ciphertext[FINAL_MAX_BYTES + STREAM_OVERHEAD_BYTES];
        unsigned char aad[AAD_MAX_BYTES];
        unsigned long long ciphertext_length = 0U;
        size_t plaintext_length = 0U;
        size_t aad_length = 0U;
        if (build_final_plaintext(header_hash, &selected, logical_hash, plaintext,
                                  &plaintext_length) != 0 ||
            build_aad(header_hash, selected.message_count, 2U, selected.message_count,
                      aad, &aad_length) != 0 ||
            crypto_secretstream_xchacha20poly1305_push(
                &stream, ciphertext, &ciphertext_length, plaintext, plaintext_length,
                aad, aad_length, crypto_secretstream_xchacha20poly1305_TAG_FINAL) != 0 ||
            ciphertext_length != plaintext_length + STREAM_OVERHEAD_BYTES ||
            write_frame_files(argv[2], selected.message_count, aad, aad_length, plaintext,
                              plaintext_length, ciphertext, (size_t) ciphertext_length,
                              "FINAL\n", NULL) != 0) {
            fprintf(stderr, "FINAL frame generation failed\n");
            return 70;
        }
    }

    metadata_length = snprintf(
        metadata, sizeof metadata,
        "format=veyora-secretstream-oracle-v1\ncase=%s\nlogical_size=%llu\nmessage_count=%zu\nframe_count=%zu\nchunk_plaintext_bytes=%u\nsecretstream_overhead=%u\nbackup_header_bytes=%zu\nlibrary_version=%s\n",
        selected.name, (unsigned long long) selected.logical_size,
        selected.message_count, selected.message_count + 1U,
        (unsigned int) BACKUP_CHUNK_BYTES, (unsigned int) STREAM_OVERHEAD_BYTES,
        backup_header_length, sodium_version_string());
    if (metadata_length <= 0 || (size_t) metadata_length >= sizeof metadata ||
        write_text(argv[2], "metadata.txt", metadata) != 0) return 74;

    sodium_memzero(key, sizeof key);
    sodium_memzero(stream_header, sizeof stream_header);
    sodium_memzero(&stream, sizeof stream);
    return 0;
}
