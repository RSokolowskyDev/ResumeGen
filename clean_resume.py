"""
clean_resume.py — Strip citation artifacts from resume text files.

Usage:
    python clean_resume.py input.txt
    python clean_resume.py input.txt -o output.txt
    python clean_resume.py input.txt --inplace

Removes:
    [cite_start]
    [cite: 1, 2, 3]
    [cite_end]
    Markdown bold/italic (**text** → text, *text* → text)
    Markdown headings (## Header → Header)
"""

import re
import sys
import argparse
from pathlib import Path


def clean(text: str) -> str:
    # Remove citation artifacts
    text = re.sub(r'\[cite_start\]', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\[cite:\s*[\d,\s]+\]', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\[cite_end\]', '', text, flags=re.IGNORECASE)

    # Remove markdown bold/italic
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    text = re.sub(r'\*(.+?)\*', r'\1', text)

    # Remove markdown headings (## → nothing, keep the text)
    text = re.sub(r'^#{1,6}\s*', '', text, flags=re.MULTILINE)

    # Collapse multiple spaces (but not newlines)
    text = re.sub(r'[ \t]{2,}', ' ', text)

    # Collapse 3+ blank lines to 2
    text = re.sub(r'\n{3,}', '\n\n', text)

    return text.strip()


def main():
    parser = argparse.ArgumentParser(description='Strip citation artifacts from resume text.')
    parser.add_argument('input', help='Input file path')
    parser.add_argument('-o', '--output', help='Output file path (default: print to stdout)')
    parser.add_argument('--inplace', action='store_true', help='Overwrite the input file')
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f'Error: File not found: {args.input}', file=sys.stderr)
        sys.exit(1)

    original = input_path.read_text(encoding='utf-8')
    cleaned = clean(original)

    if args.inplace:
        input_path.write_text(cleaned, encoding='utf-8')
        print(f'Cleaned in place: {input_path}')
    elif args.output:
        Path(args.output).write_text(cleaned, encoding='utf-8')
        print(f'Cleaned output written to: {args.output}')
    else:
        print(cleaned)


if __name__ == '__main__':
    main()
