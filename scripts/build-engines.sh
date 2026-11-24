#!/usr/bin/env bash
# Builds the Linux engines Hatchlight runs local models with:
# stable-diffusion.cpp (sd-cli, sd-server) and llama.cpp (llama-server,
# llama-completion, llama-mtmd-cli), for linux-x64, on the processor (`cpu`)
# or on NVIDIA cards (`cuda`). Hatchlight runs llama.cpp on the processor
# only, so its cuda build is there for whoever wants one, not published.
#
# It runs inside Ubuntu 22.04 so the programs need glibc 2.35 at most:
# `ubuntu:22.04` for cpu, `nvidia/cuda:12.8.1-devel-ubuntu22.04` for cuda.
# .github/workflows/engines.yml runs it there; on a machine with Docker:
#
#   docker run --rm -v "$PWD:/src" -w /src ubuntu:22.04 \
#     sh -c 'scripts/build-engines.sh deps && scripts/build-engines.sh build sd-cpp cpu dist'
#
# Each archive holds the programs and the shared libraries they load, at its
# top level, with RUNPATH $ORIGIN so they run from their own folder. The CUDA
# runtime (libcudart, libcublas, libcublasLt) and the driver (libcuda) are
# NOT included in cuda archives: the image that runs them (an nvidia/cuda
# runtime image, with the NVIDIA container toolkit) provides them.
#
# Usage:
#   build-engines.sh deps                            installs the toolchain (root)
#   build-engines.sh build <engine> <variant> <out>  builds one archive into <out>
#
#   engine:  sd-cpp | llama-cpp
#   variant: cpu | cuda
#
# Environment:
#   SD_CPP_VERSION      stable-diffusion.cpp release tag (master-1106-532d2c1)
#   LLAMA_CPP_VERSION   llama.cpp release tag (b12034)
#   CUDA_ARCHITECTURES  CMAKE_CUDA_ARCHITECTURES for cuda builds
#   GGML_CUDA_CCCL      CCCL tag llama.cpp fetches for CUDA below 13.5 (v3.4.3)
#   WORK_DIR            where sources and builds go (a temporary folder);
#                       kept sources are used again only if at the tag
#   CMAKE_BUILD_PARALLEL_LEVEL  compilers run at once (all processors)
#   SOURCE_DATE_EPOCH   timestamp written into the archives (0)

set -euo pipefail

SD_CPP_VERSION="${SD_CPP_VERSION:-master-1106-532d2c1}"
LLAMA_CPP_VERSION="${LLAMA_CPP_VERSION:-b12034}"
# Turing (75), Ampere (80, 86), Ada / RTX 40 (89), Hopper (90) and Blackwell
# (120a, which needs CUDA 12.8). Real code for the common consumer cards,
# PTX for the others, which the driver compiles on first use.
CUDA_ARCHITECTURES="${CUDA_ARCHITECTURES:-75-real;80-virtual;86-real;89-real;90-virtual;120a-real}"
GGML_CUDA_CCCL="${GGML_CUDA_CCCL:-v3.4.3}"
CMAKE_VERSION="3.31.6"
NINJA_VERSION="1.11.1.4"

die() {
	echo "build-engines: $*" >&2
	exit 1
}

# Versions end up in paths, URLs and a release tag: keep them plain.
check_version() {
	[[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || die "not a version: $1"
}

deps() {
	export DEBIAN_FRONTEND=noninteractive
	apt-get update
	apt-get install -y --no-install-recommends \
		build-essential git ca-certificates python3-pip file binutils
	# Ubuntu 22.04 has CMake 3.22; a recent one knows the Blackwell
	# architectures and the CUDA 12.8 toolkit. The wheels are pinned by the
	# sha256 PyPI lists for them (manylinux x86_64).
	local requirements
	requirements="$(mktemp)"
	cat >"$requirements" <<-EOF
		cmake==${CMAKE_VERSION} \\
		    --hash=sha256:1c8b05df0602365da91ee6a3336fe57525b137706c4ab5675498f662ae1dbcec \\
		    --hash=sha256:2297e9591307d9c61e557efe737bcf4d7c13a30f1f860732f684a204fee24dca
		ninja==${NINJA_VERSION} \\
		    --hash=sha256:096487995473320de7f65d622c3f1d16c3ad174797602218ca8c967f51ec38a0
	EOF
	pip3 install --no-cache-dir --no-deps --only-binary :all: \
		--require-hashes -r "$requirements"
	rm -f "$requirements"
	cmake --version
}

# Clones a release tag with the submodules given, shallowly.
fetch() {
	local repo="$1" tag="$2" dir="$3"
	shift 3
	# A WORK_DIR kept from an earlier run may have them already: at the tag,
	# unchanged and with the submodules, or they are fetched again.
	if [[ -d "$dir/.git" ]]; then
		local head wanted changes submodules
		head="$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)"
		wanted="$(git -C "$dir" rev-parse --verify --quiet "refs/tags/$tag^{commit}" || true)"
		changes="$(git -C "$dir" status --porcelain 2>/dev/null || echo broken)"
		# A submodule missing, at another commit or in conflict starts with -, + or U.
		submodules="$(git -C "$dir" submodule status -- "$@" 2>/dev/null || echo -)"
		if [[ -n "$head" && "$head" == "$wanted" && -z "$changes" &&
			! "$submodules" =~ (^|$'\n')[-+U] ]]; then
			echo "Using the sources of $tag in $dir"
			return
		fi
		echo "The sources in $dir are not those of $tag: fetching them again"
		rm -rf "$dir"
	fi
	git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" "$repo" "$dir"
	if (($# > 0)); then
		git -C "$dir" submodule update --quiet --init --depth 1 "$@"
	fi
}

build_sd_cpp() {
	local variant="$1" src="$2" build="$3"
	local submodules=(ggml thirdparty/libwebp thirdparty/libwebm)
	if [[ "$variant" == cuda ]]; then submodules+=(thirdparty/cutlass); fi
	fetch https://github.com/leejet/stable-diffusion.cpp.git \
		"$SD_CPP_VERSION" "$src" "${submodules[@]}"
	# Tags are master-<n>-<commit>: check the commit is the one named.
	local commit="${SD_CPP_VERSION##*-}"
	if [[ "$SD_CPP_VERSION" == master-* ]]; then
		[[ "$(git -C "$src" rev-parse --short=7 HEAD)" == "$commit" ]] ||
			die "$SD_CPP_VERSION does not point at commit $commit"
	fi

	# The same options upstream's own Linux release uses, with the server's
	# web page left out: Hatchlight only uses its API.
	local args=(
		-DSD_BUILD_SHARED_LIBS=ON
		-DSD_BUILD_SHARED_GGML_LIB=ON
		-DSD_SERVER_BUILD_FRONTEND=OFF
	)
	if [[ "$variant" == cuda ]]; then
		args+=(-DSD_CUDA=ON "-DCMAKE_CUDA_ARCHITECTURES=${CUDA_ARCHITECTURES}")
	fi
	configure "$src" "$build" "${args[@]}"
	cmake --build "$build" --config Release --target sd-cli sd-server
	# Backends loaded at run time are no link dependency of the programs.
	cmake --build "$build" --config Release
}

build_llama_cpp() {
	local variant="$1" src="$2" build="$3"
	fetch https://github.com/ggml-org/llama.cpp.git "$LLAMA_CPP_VERSION" "$src"
	local args=(
		-DLLAMA_BUILD_TESTS=OFF
		-DLLAMA_BUILD_EXAMPLES=OFF
		-DLLAMA_BUILD_TOOLS=ON
		-DLLAMA_BUILD_SERVER=ON
		# No downloads from the programs, and no web page in the server.
		-DLLAMA_OPENSSL=OFF
		-DLLAMA_BUILD_UI=OFF
		-DLLAMA_USE_PREBUILT_UI=OFF
	)
	# A shallow clone cannot count commits: the tag is the build number.
	if [[ "$LLAMA_CPP_VERSION" =~ ^b([0-9]+)$ ]]; then
		args+=("-DLLAMA_BUILD_NUMBER=${BASH_REMATCH[1]}")
	fi
	if [[ "$variant" == cuda ]]; then
		args+=(
			-DGGML_CUDA=ON
			-DGGML_CUDA_NCCL=OFF
			"-DCMAKE_CUDA_ARCHITECTURES=${CUDA_ARCHITECTURES}"
		)
		# What upstream's release does for CUDA toolkits before 13.5.
		if [[ -n "$GGML_CUDA_CCCL" ]]; then
			args+=("-DGGML_CUDA_CCCL_VERSION=${GGML_CUDA_CCCL}")
		fi
	fi
	configure "$src" "$build" "${args[@]}"
	cmake --build "$build" --config Release
}

configure() {
	local src="$1" build="$2"
	shift 2
	# Portable: every x86-64 processor, the right CPU code picked at run time
	# from the ggml-cpu-* libraries; programs find libraries next to them.
	# shellcheck disable=SC2016 # $ORIGIN is for the loader, not the shell.
	cmake -S "$src" -B "$build" -G Ninja \
		-DCMAKE_BUILD_TYPE=Release \
		-DGGML_NATIVE=OFF \
		-DGGML_BACKEND_DL=ON \
		-DGGML_CPU_ALL_VARIANTS=ON \
		-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON \
		'-DCMAKE_INSTALL_RPATH=$ORIGIN' \
		"$@"
}

# Libraries the CUDA image provides, never shipped in an archive.
is_cuda_runtime() {
	[[ "$1" =~ ^lib(cuda|cudart|cublas|cublasLt|nvidia-ml)\.so ]]
}

# Puts the programs, their libraries and the licenses in `stage`, and checks
# that everything loads from there.
stage() {
	local engine="$1" variant="$2" src="$3" build="$4" stage="$5"
	shift 5
	local programs=("$@")
	mkdir -p "$stage"
	for program in "${programs[@]}"; do
		[[ -x "$build/bin/$program" ]] || die "$program was not built"
		cp "$build/bin/$program" "$stage/"
	done
	# Every shared library of the build (links included), loaded at start or
	# at run time (ggml-cpu-*, ggml-cuda).
	find "$build/bin" -maxdepth 1 -name 'lib*.so*' -exec cp -a {} "$stage/" \;

	# OpenMP comes from the compiler, not from every system: ship it too.
	local lib
	while read -r lib; do
		cp -L "$lib" "$stage/"
	done < <(
		for file in "$stage"/*; do
			[[ -L "$file" ]] || ldd "$file" 2>/dev/null || true
		done | awk '$1 ~ /^libgomp\.so/ && $3 ~ /^\// { print $3 }' | sort -u
	)

	cp "$src/LICENSE" "$stage/LICENSE-${engine}.txt"
	if [[ "$engine" == sd-cpp ]]; then
		cp "$src/ggml/LICENSE" "$stage/LICENSE-ggml.txt"
		if [[ "$variant" == cuda ]]; then
			cp "$src/thirdparty/cutlass/LICENSE.txt" "$stage/LICENSE-cutlass.txt"
		fi
	fi

	# Everything built here must look for libraries in its own folder, and
	# nothing may be missing but the CUDA runtime.
	local file name missing
	for file in "$stage"/*; do
		[[ -L "$file" ]] && continue
		[[ "$(file -b "$file")" == ELF* ]] || continue
		name="$(basename "$file")"
		# Read whole first: grep -q stopping early would fail the pipe.
		# shellcheck disable=SC2016 # a literal $ORIGIN
		if [[ ! "$name" =~ ^libgomp && ! "$(readelf -d "$file")" =~ (RUNPATH|RPATH).*'$ORIGIN' ]]; then
			die "$name does not look for libraries next to itself"
		fi
		missing="$(ldd "$file" | awk '/not found/ { print $1 }' || true)"
		for lib in $missing; do
			is_cuda_runtime "$lib" || die "$name needs $lib, which is not in the archive"
		done
	done
}

# Runs the main program the way Hatchlight checks a fresh install, from a
# copy elsewhere, so nothing from the build folder can be used.
smoke() {
	local stage="$1" program="$2"
	local copy
	copy="$(mktemp -d)"
	cp -a "$stage/." "$copy/"
	env -u LD_LIBRARY_PATH "$copy/$program" --help >/dev/null ||
		die "$program --help failed"
	rm -rf "$copy"
}

build() {
	local engine="$1" variant="$2" out="$3"
	[[ "$variant" == cpu || "$variant" == cuda ]] || die "unknown variant: $variant"
	check_version "$SD_CPP_VERSION"
	check_version "$LLAMA_CPP_VERSION"
	mkdir -p "$out"
	out="$(cd "$out" && pwd)"
	local version programs
	case "$engine" in
	sd-cpp)
		version="$SD_CPP_VERSION"
		programs=(sd-cli sd-server)
		;;
	llama-cpp)
		version="$LLAMA_CPP_VERSION"
		programs=(llama-server llama-completion llama-mtmd-cli)
		;;
	*) die "unknown engine: $engine" ;;
	esac

	local work="${WORK_DIR:-$(mktemp -d)}"
	local src="$work/$engine-$version-src"
	local build="$work/$engine-$version-$variant-build"
	local staged="$work/$engine-$version-$variant-stage"
	rm -rf "$staged"
	if [[ "$engine" == sd-cpp ]]; then
		build_sd_cpp "$variant" "$src" "$build"
	else
		build_llama_cpp "$variant" "$src" "$build"
	fi

	stage "$engine" "$variant" "$src" "$build" "$staged" "${programs[@]}"
	# Without a driver a cuda program cannot start; its libraries were checked.
	if [[ "$variant" == cpu ]]; then smoke "$staged" "${programs[0]}"; fi

	local name="${engine}-${version}-linux-x64-${variant}.tar.gz"
	tar --sort=name --owner=0 --group=0 --numeric-owner \
		--mtime="@${SOURCE_DATE_EPOCH:-0}" -C "$staged" -cf - . |
		gzip -9n >"$out/$name"
	(cd "$out" && sha256sum "$name" >"$name.sha256")
	echo "Built $out/$name"
	tar -tvzf "$out/$name"
	cat "$out/$name.sha256"
}

case "${1:-}" in
deps) deps ;;
build)
	(($# == 4)) || die "usage: $0 build <sd-cpp|llama-cpp> <cpu|cuda> <out>"
	build "$2" "$3" "$4"
	;;
*) die "usage: $0 deps | build <sd-cpp|llama-cpp> <cpu|cuda> <out>" ;;
esac
