const PATROLLING_LAYOUT_STYLES = `
    @media print {
        .patrolling-photos-flow {
            break-before: auto !important;
            page-break-before: auto !important;
        }

        .patrolling-photos-heading {
            break-after: avoid !important;
            page-break-after: avoid !important;
        }

        .patrolling-officer-columns {
            display: grid !important;
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
            column-gap: 6mm !important;
            align-items: start !important;
            width: 100% !important;
        }

        .patrolling-officer-column {
            min-width: 0 !important;
            margin-top: 0 !important;
            margin-bottom: 0 !important;
            break-inside: avoid;
            page-break-inside: avoid;
        }

        .patrolling-photo-keep-together {
            break-inside: avoid !important;
            page-break-inside: avoid !important;
        }

        .patrolling-photo-flow {
            break-inside: auto !important;
            page-break-inside: auto !important;
        }

        .patrolling-gallery-grid {
            display: grid !important;
            grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
            gap: 4mm !important;
            align-items: start !important;
            width: 100% !important;
        }

        .patrolling-gallery-item {
            min-width: 0 !important;
            break-inside: avoid;
            page-break-inside: avoid;
        }

        .patrolling-photo-image {
            display: block !important;
            max-width: 100% !important;
            height: auto !important;
            max-height: 70mm !important;
            object-fit: contain !important;
            object-position: center !important;
        }

        .patrolling-photo-count-1 .patrolling-photo-image,
        .patrolling-photo-count-2 .patrolling-photo-image {
            max-height: none !important;
        }

        .patrolling-gallery-grid .patrolling-photo-image {
            width: 100% !important;
        }
    }
`;

async function preparePatrollingPage(page) {
    const summary = await page.evaluate(() => {
        const OFFICER_HEADING = "OFFICERS ON DUTY";
        const PHOTO_HEADINGS = [
            "OFFICER PHOTO",
            "OFFICER PICTURE",
            "OCCURRENCE BOOK",
            "OE CHOP OCCURRENCE",
        ];

        function normalizeText(value) {
            return String(value || "")
                .replace(/\s+/g, " ")
                .trim()
                .toUpperCase();
        }

        function getDepth(element) {
            let depth = 0;
            let current = element;
            while (current && current.parentElement) {
                depth += 1;
                current = current.parentElement;
            }
            return depth;
        }

        function exactTextElements(label) {
            const selector =
                "h1,h2,h3,h4,h5,h6,[role='heading']," +
                "[data-section-title],strong,b,div,span,p,td,th";

            return Array.from(document.querySelectorAll(selector))
                .filter((element) => normalizeText(element.textContent) === label)
                .sort((left, right) => getDepth(right) - getDepth(left));
        }

        function firstExactTextElement(label) {
            return exactTextElements(label)[0] || null;
        }

        function directListItems(list) {
            const tagName = String(list.tagName || "").toLowerCase();

            if (tagName === "ul" || tagName === "ol") {
                return Array.from(list.children).filter(
                    (child) => child.tagName === "LI"
                );
            }

            return Array.from(
                list.querySelectorAll("[role='listitem'],[data-officer-item]")
            ).filter((item) => item.parentElement === list);
        }

        function findOfficerList(heading) {
            let current = heading;

            for (let level = 0; current && level < 8; level += 1) {
                const candidates = Array.from(
                    current.querySelectorAll(
                        "ul,ol,[role='list'],[data-officer-list]," +
                            ".officers-list,.officer-list"
                    )
                );

                for (const candidate of candidates) {
                    const items = directListItems(candidate);
                    if (items.length > 0) {
                        return { list: candidate, items };
                    }
                }

                current = current.parentElement;
            }

            return null;
        }

        function copyListAttributes(source, target) {
            for (const attribute of Array.from(source.attributes || [])) {
                if (attribute.name === "id") continue;
                target.setAttribute(attribute.name, attribute.value);
            }

            target.classList.add("patrolling-officer-column");
            target.removeAttribute("data-officer-list");
        }

        function splitOfficers() {
            const heading = firstExactTextElement(OFFICER_HEADING);
            if (!heading) {
                return { count: 0, split: false };
            }

            const found = findOfficerList(heading);
            if (!found || found.items.length <= 3) {
                return {
                    count: found ? found.items.length : 0,
                    split: false,
                };
            }

            const { list, items } = found;
            if (list.parentElement?.querySelector(
                ".patrolling-officer-columns"
            )) {
                return { count: items.length, split: false };
            }

            const listTag = ["UL", "OL"].includes(list.tagName)
                ? list.tagName.toLowerCase()
                : "div";
            const leftList = document.createElement(listTag);
            const rightList = document.createElement(listTag);
            copyListAttributes(list, leftList);
            copyListAttributes(list, rightList);

            const leftCount = Math.ceil(items.length / 2);
            items.forEach((item, index) => {
                (index < leftCount ? leftList : rightList).appendChild(item);
            });

            const columns = document.createElement("div");
            columns.className = "patrolling-officer-columns";
            columns.setAttribute("data-patrolling-officer-count", items.length);
            columns.append(leftList, rightList);
            list.replaceWith(columns);

            return { count: items.length, split: true };
        }

        function isPhotosContainer(element) {
            const className = String(element.getAttribute("class") || "");
            const id = String(element.getAttribute("id") || "");
            const dataSection = String(
                element.getAttribute("data-section") || ""
            );

            return (
                /(^|\s)photos?(?:-section)?(\s|$)/i.test(className) ||
                /^photos?$/i.test(id) ||
                /^photos?$/i.test(dataSection)
            );
        }

        function removePhotosForcedBreak(heading) {
            let removed = false;
            let current = heading;

            for (let level = 0; current && level < 10; level += 1) {
                const computed = window.getComputedStyle(current);
                const breakBefore = normalizeText(
                    computed.breakBefore || computed.pageBreakBefore
                );
                const isForcedBreak = [
                    "PAGE",
                    "ALWAYS",
                    "LEFT",
                    "RIGHT",
                    "RECTO",
                    "VERSO",
                ].includes(breakBefore);

                if (isForcedBreak) {
                    current.style.setProperty(
                        "break-before",
                        "auto",
                        "important"
                    );
                    current.style.setProperty(
                        "page-break-before",
                        "auto",
                        "important"
                    );
                    current.classList.add("patrolling-photos-flow");
                    removed = true;
                    break;
                }

                current = current.parentElement;
            }

            const knownContainer = heading.closest(
                ".photos-section,.photos,[data-section='photos'],#photos"
            );
            if (knownContainer) {
                knownContainer.style.setProperty(
                    "break-before",
                    "auto",
                    "important"
                );
                knownContainer.style.setProperty(
                    "page-break-before",
                    "auto",
                    "important"
                );
                knownContainer.classList.add("patrolling-photos-flow");
            }

            heading.classList.add("patrolling-photos-heading");

            return removed;
        }

        function findPhotoBlock(heading) {
            const explicitBlock = heading.closest(
                ".photo-block,[data-photo-block],[data-photo-field]"
            );
            if (explicitBlock && explicitBlock.querySelector("img")) {
                return explicitBlock;
            }

            let current = heading.parentElement;
            for (let level = 0; current && level < 8; level += 1) {
                if (isPhotosContainer(current)) {
                    break;
                }

                const imageCount = current.querySelectorAll("img").length;
                if (imageCount > 0 && imageCount <= 5) {
                    return current;
                }

                current = current.parentElement;
            }

            return null;
        }

        function findGallery(block, images) {
            const knownGallery = block.querySelector(
                ".gallery-grid,[data-gallery]"
            );
            if (knownGallery) return knownGallery;
            if (images.length < 2) return null;

            let current = images[0].parentElement;
            while (current && block.contains(current)) {
                const containsAllImages = images.every((image) =>
                    current.contains(image)
                );
                if (containsAllImages) return current;
                if (current === block) break;
                current = current.parentElement;
            }

            return null;
        }

        function markGalleryItems(gallery, images) {
            gallery.classList.add("patrolling-gallery-grid");

            for (const image of images) {
                image.classList.add("patrolling-photo-image");

                let item = image;
                while (item.parentElement && item.parentElement !== gallery) {
                    item = item.parentElement;
                }
                item.classList.add("patrolling-gallery-item");
            }
        }

        function preparePhotoBlocks() {
            const seenBlocks = new Set();
            const prepared = [];

            for (const label of PHOTO_HEADINGS) {
                for (const heading of exactTextElements(label)) {
                    const block = findPhotoBlock(heading);
                    if (!block || seenBlocks.has(block)) continue;
                    seenBlocks.add(block);

                    const images = Array.from(block.querySelectorAll("img"));
                    if (images.length === 0) continue;

                    const countBucket = Math.min(images.length, 5);
                    block.classList.add("patrolling-photo-block");
                    block.classList.add(
                        `patrolling-photo-count-${countBucket}`
                    );

                    if (images.length <= 4) {
                        block.classList.add("patrolling-photo-keep-together");
                    } else {
                        block.classList.add("patrolling-photo-flow");
                    }

                    const gallery = findGallery(block, images);
                    if (gallery && images.length > 1) {
                        markGalleryItems(gallery, images);
                    } else {
                        images.forEach((image) =>
                            image.classList.add("patrolling-photo-image")
                        );
                    }

                    prepared.push({
                        label,
                        count: images.length,
                        keptTogether: images.length <= 4,
                        gallery: Boolean(gallery && images.length > 1),
                    });
                }
            }

            return prepared;
        }

        const officer = splitOfficers();
        const photosHeading = firstExactTextElement("PHOTOS");
        const forcedBreakRemoved = photosHeading
            ? removePhotosForcedBreak(photosHeading)
            : false;

        return {
            officerCount: officer.count,
            officerSplit: officer.split,
            forcedBreakRemoved,
            photoBlocks: preparePhotoBlocks(),
        };
    });

    return summary;
}

module.exports = {
    PATROLLING_LAYOUT_STYLES,
    preparePatrollingPage,
};
